#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
const semver = require("semver");
const dotenv = require("dotenv");
dotenv.config();

// Registry configuration
const REGISTRY_URL =
  "https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json";

// Processing configuration
const CONFIG = {
  BATCH_SIZE: parseInt(process.env.BATCH_SIZE) || 10, // Number of repos to process in parallel
  RETRY_ATTEMPTS: parseInt(process.env.RETRY_ATTEMPTS) || 3, // Number of retries for API calls
  BATCH_DELAY_MS: parseInt(process.env.BATCH_DELAY_MS) || 1000, // Delay between batches in milliseconds
};

// Helper function to safely fetch JSON
async function safeFetchJSON(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data;
  } catch {
    return null;
  }
}

// Helper function to normalize dependency ranges for semver checks
function normalizeDependencyRange(depRange) {
  if (!depRange || typeof depRange !== 'string') {
    return null;
  }
  
  // Handle common edge cases
  const trimmed = depRange.trim();
  
  // Handle "latest" - treat as very high version that satisfies anything
  if (trimmed === 'latest') {
    return '>=0.0.0';
  }
  
  // Handle exact versions without operators (e.g., "0.25.6-alpha.1", "1.0.0")
  if (semver.valid(semver.clean(trimmed))) {
    // If it's an exact version, convert to ">=" range
    const cleanVersion = semver.clean(trimmed);
    return `>=${cleanVersion}`;
  }
  
  // Handle URL dependencies or invalid ranges
  if (trimmed.startsWith('http') || trimmed.startsWith('git') || trimmed.startsWith('file:')) {
    return null;
  }
  
  // Validate the range and return the normalized value (or null)
  try {
    const valid = semver.validRange(trimmed);
    return valid || null;
  } catch {
    return null;
  }
}

// Check if plugin's core dependency range intersects a major version band
function isCompatibleWithMajorVersion(pluginCoreRange, majorVersion) {
  try {
    const normalizedRange = normalizeDependencyRange(pluginCoreRange);
    if (!normalizedRange) {
      return false;
    }

    // v0 band: >0.x and <1.x  → [0.0.0, 1.0.0)
    // v1 band: >1.x and <2.x  → [1.0.0, 2.0.0)
    const band = majorVersion === 0 ? ">=0.0.0 <1.0.0" : ">=1.0.0 <2.0.0";
    return semver.intersects(normalizedRange, band, { includePrerelease: true });
  } catch (error) {
    console.warn(`  Failed to check compatibility for major version ${majorVersion} against ${pluginCoreRange}: ${error.message}`);
    return false;
  }
}

// Parse GitHub reference
function parseGitRef(gitRef) {
  if (!gitRef.startsWith("github:")) return null;
  const repoPath = gitRef.slice("github:".length);
  const [owner, repo] = repoPath.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

// Get GitHub branches with retry logic
async function getGitHubBranches(owner, repo, octokit, retries = CONFIG.RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await octokit.rest.repos.listBranches({ owner, repo });
      return data.map((b) => b.name);
    } catch (error) {
      if (attempt === retries) {
        console.warn(`  Failed to get branches for ${owner}/${repo} after ${retries} attempts: ${error.message}`);
        return [];
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return [];
}

// Get GitHub repository information (including description) with retry logic
async function getGitHubRepoInfo(owner, repo, octokit, retries = CONFIG.RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return {
        description: data.description || null,
        homepage: data.homepage || null,
        topics: data.topics || [],
        stargazers_count: data.stargazers_count || 0,
        language: data.language || null
      };
    } catch (error) {
      if (attempt === retries) {
        console.warn(`  Failed to get repo info for ${owner}/${repo} after ${retries} attempts: ${error.message}`);
        return {
          description: null,
          homepage: null,
          topics: [],
          stargazers_count: 0,
          language: null
        };
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return {
    description: null,
    homepage: null,
    topics: [],
    stargazers_count: 0,
    language: null
  };
}

// Fetch package.json from GitHub with retry logic
async function fetchPackageJSON(owner, repo, ref, octokit, retries = CONFIG.RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: "package.json",
        ref,
      });
      if (!("content" in data)) return null;
      const pkg = JSON.parse(Buffer.from(data.content, "base64").toString());
      const coreRange =
        pkg.dependencies?.["@elizaos/core"] ||
        pkg.peerDependencies?.["@elizaos/core"] ||
        undefined;
      return { version: pkg.version, coreRange };
    } catch (error) {
      if (attempt === retries) {
        console.warn(`  Failed to fetch package.json from ${owner}/${repo}@${ref} after ${retries} attempts: ${error.message}`);
        return null;
      }
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
  return null;
}

// Get latest Git tags
async function getLatestGitTags(owner, repo, octokit) {
  try {
    const { data } = await octokit.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
    });
    
    // Filter tags that have valid semver versions
    const validTags = data.filter(tag => semver.clean(tag.name));
    
    // Sort by cleaned version (for comparison) but keep original tag names
    const sorted = validTags.sort((a, b) => 
      semver.rcompare(semver.clean(a.name), semver.clean(b.name))
    );
    
    // Find latest v0 tag
    const latestV0Tag = sorted.find((tag) => semver.major(semver.clean(tag.name)) === 0);
    
    // Find latest v1 tag (including beta and stable)
    const v1Tags = sorted.filter((tag) => semver.major(semver.clean(tag.name)) === 1);
    let latestV1Tag = null;
    
    if (v1Tags.length > 0) {
      // First, try to find a stable v1 tag
      const stableV1Tag = v1Tags.find(tag => !semver.clean(tag.name).includes('-'));
      if (stableV1Tag) {
        latestV1Tag = stableV1Tag;
      } else {
        // If no stable version, use the latest pre-release
        latestV1Tag = v1Tags[0];
      }
    }
    
    return {
      repo: `${owner}/${repo}`,
      v0: latestV0Tag ? latestV0Tag.name : null,
      v1: latestV1Tag ? latestV1Tag.name : null,
    };
  } catch (error) {
    console.warn(`Failed to get tags for ${owner}/${repo}:`, error.message);
    return { repo: `${owner}/${repo}`, v0: null, v1: null };
  }
}

// Inspect NPM package
async function inspectNpm(pkgName) {
  const meta = await safeFetchJSON(`https://registry.npmjs.org/${pkgName}`);
  if (!meta || !meta.versions) {
    return { repo: pkgName, v0: null, v1: null, v0CoreRange: null, v1CoreRange: null };
  }
  const versions = Object.keys(meta.versions);
  const sorted = versions.sort(semver.rcompare);
  
  // Find latest v0 version
  const v0 = sorted.find((v) => semver.major(v) === 0) || null;
  
  // Find latest v1 version (including beta and stable)
  const v1Versions = sorted.filter((v) => semver.major(v) === 1);
  let v1 = null;
  
  if (v1Versions.length > 0) {
    // First, try to find a stable v1 version
    const stableV1 = v1Versions.find(v => !v.includes('-'));
    if (stableV1) {
      v1 = stableV1;
    } else {
      // If no stable version, use the latest pre-release
      v1 = v1Versions[0];
    }
  }
  
  // Get core dependency ranges for the found versions
  let v0CoreRange = null;
  let v1CoreRange = null;
  
  if (v0 && meta.versions[v0]) {
    const v0Pkg = meta.versions[v0];
    v0CoreRange = v0Pkg.dependencies?.["@elizaos/core"] || 
                  v0Pkg.peerDependencies?.["@elizaos/core"] || null;
  }
  
  if (v1 && meta.versions[v1]) {
    const v1Pkg = meta.versions[v1];
    v1CoreRange = v1Pkg.dependencies?.["@elizaos/core"] || 
                  v1Pkg.peerDependencies?.["@elizaos/core"] || null;
  }
  
  return {
    repo: pkgName,
    v0,
    v1,
    v0CoreRange,
    v1CoreRange,
  };
}

// Guess NPM name from JS name
function guessNpmName(jsName) {
  // Keep @elizaos-plugins/ scope for packages that exist under the new scope
  // For now, fallback to @elizaos/ for compatibility, but this should be updated
  // when packages are fully migrated to @elizaos-plugins/
  return jsName.replace(/^@elizaos-plugins\//, "@elizaos/");
}

// Process a single repository
async function processRepo(npmId, gitRef, octokit) {
  const parsed = parseGitRef(gitRef);
  if (!parsed) {
    throw new Error(`Invalid git reference: ${gitRef}`);
  }
  const { owner, repo } = parsed;

  console.log(`Processing ${npmId} (${owner}/${repo})`);

  // Track issues for summary
  const issues = [];

  // Kick off remote calls
  const branchesPromise = getGitHubBranches(owner, repo, octokit);
  const tagsPromise = getLatestGitTags(owner, repo, octokit);
  const repoInfoPromise = getGitHubRepoInfo(owner, repo, octokit);
  const npmPromise = inspectNpm(guessNpmName(npmId));

  // Support detection via package.json across relevant branches
  const branches = await branchesPromise;
  if (branches.length === 0) {
    issues.push(`No branches found (might be API issue)`);
  }
  const branchCandidates = ["main", "master", "0.x", "1.x"].filter((b) =>
    branches.includes(b)
  );
  if (branchCandidates.length === 0 && branches.length > 0) {
    issues.push(`No standard branches found (has: ${branches.slice(0, 3).join(', ')}${branches.length > 3 ? '...' : ''})`);
  }

  const pkgPromises = branchCandidates.map((br) =>
    fetchPackageJSON(owner, repo, br, octokit)
  );
  const pkgResults = await Promise.allSettled(pkgPromises);

  const pkgs = [];
  const supportedBranches = {
    v0: null,
    v1: null,
  };

  for (let i = 0; i < pkgResults.length; i++) {
    const result = pkgResults[i];
    if (result.status === "fulfilled" && result.value) {
      const branch = branchCandidates[i];
      const pkg = result.value;
      pkgs.push({ ...pkg, branch });
    } else if (result.status === "rejected") {
      console.warn(`  Failed to fetch package.json from ${branchCandidates[i]} branch: ${result.reason?.message || 'Unknown error'}`);
    }
  }

  let supportsV0 = false;
  let supportsV1 = false;

  for (const pkg of pkgs) {
    if (pkg.version && pkg.coreRange) {
      const pkgMajor = semver.major(semver.clean(pkg.version));
      const satisfiesV0Core = isCompatibleWithMajorVersion(pkg.coreRange, 0);
      const satisfiesV1Core = isCompatibleWithMajorVersion(pkg.coreRange, 1);

      // For v0: package version must be < 1.0.0 AND core dependency should be compatible
      // Branches can be "0.x" or "main"
      if (pkgMajor === 0 && satisfiesV0Core) {
        supportsV0 = true;
        supportedBranches.v0 = pkg.branch;
      }
      
      // For v1: package version must be >= 1.0.0 AND core dependency should be compatible
      // Only set v1 branch if the package version is actually v1
      if (pkgMajor >= 1 && satisfiesV1Core) {
        supportsV1 = true;
        supportedBranches.v1 = pkg.branch;
      }
    }
  }

  const [gitTagInfo, npmInfo, repoInfo] = await Promise.all([tagsPromise, npmPromise, repoInfoPromise]);

  // Set version support based on npm versions and core dependencies (more reliable)
  // Check if NPM versions have proper core dependencies
  if (npmInfo?.v0 && npmInfo?.v0CoreRange) {
    const v0Major = semver.major(semver.clean(npmInfo.v0));
    const satisfiesV0Core = isCompatibleWithMajorVersion(npmInfo.v0CoreRange, 0);
    if (v0Major === 0 && satisfiesV0Core) {
      supportsV0 = true;
    }
  }
  if (npmInfo?.v1 && npmInfo?.v1CoreRange) {
    const v1Major = semver.major(semver.clean(npmInfo.v1));
    const satisfiesV1Core = isCompatibleWithMajorVersion(npmInfo.v1CoreRange, 1);
    if (v1Major >= 1 && satisfiesV1Core) {
      supportsV1 = true;
    }
  }

  console.log(`${npmId} → v0:${supportsV0} v1:${supportsV1}`);

  // Prepare git info with versions and branches
  // When GitHub data is not available, use npm data as fallback
  const gitInfo = {
    repo: gitTagInfo?.repo || npmInfo?.repo || `${owner}/${repo}`,
    v0: {
      version: gitTagInfo?.v0 || npmInfo?.v0 || null,
      branch: supportedBranches.v0,
    },
    v1: {
      version: gitTagInfo?.v1 || npmInfo?.v1 || null,
      branch: supportedBranches.v1,
    },
  };

  // Version support flags have already been properly set based on version constraints
  // No need to override them here

  return [
    npmId,
    {
      git: gitInfo,
      npm: npmInfo,
      supports: { v0: supportsV0, v1: supportsV1 },
      description: repoInfo.description,
      homepage: repoInfo.homepage,
      topics: repoInfo.topics,
      stargazers_count: repoInfo.stargazers_count,
      language: repoInfo.language,
    },
    issues,
  ];
}

// Main function to parse registry
async function parseRegistry(githubToken) {
  const octokit = new Octokit({ auth: githubToken });

  // Read local index.json file instead of fetching from URL
  const indexPath = path.join(__dirname, "..", "index.json");
  let registry;

  try {
    const indexContent = fs.readFileSync(indexPath, "utf8");
    registry = JSON.parse(indexContent);
    console.log(`Read ${Object.keys(registry).length} total entries from index.json`);
  } catch (error) {
    console.error("Failed to read index.json:", error);
    return null;
  }

  // Filter out comment entries (empty keys or keys that are just empty strings)
  const filteredRegistry = {};
  for (const [key, value] of Object.entries(registry)) {
    if (key && key.trim() !== "" && typeof value === "string" && value.startsWith("github:")) {
      filteredRegistry[key] = value;
    } else {
      console.log(`Filtering out entry: "${key}" -> "${value}"`);
    }
  }

  console.log(`Filtered to ${Object.keys(filteredRegistry).length} valid entries`);
  
  const report = {};
  const allIssues = {};
  // Sort entries alphabetically by key before processing
  const entries = Object.entries(filteredRegistry).sort(([a], [b]) => a.localeCompare(b));
  const batchSize = CONFIG.BATCH_SIZE;
  
  console.log(`Processing ${entries.length} repositories in batches of ${batchSize}...`);
  
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(entries.length / batchSize);
    
    console.log(`\nProcessing batch ${batchNumber}/${totalBatches} (${batch.length} repos)...`);
    
    const tasks = batch.map(([npmId, gitRef]) =>
      processRepo(npmId, gitRef, octokit)
    );
    
    const results = await Promise.all(tasks);
    
    for (const [id, info, issues] of results) {
      report[id] = info;
      if (issues && issues.length > 0) {
        allIssues[id] = issues;
      }
    }
    
    // Add a small delay between batches to avoid rate limiting
    if (i + batchSize < entries.length) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY_MS));
    }
  }
  
  // Report issues summary
  const issueCount = Object.keys(allIssues).length;
  if (issueCount > 0) {
    console.log(`\n⚠️  Issues encountered for ${issueCount} repositories:`);
    for (const [id, issues] of Object.entries(allIssues)) {
      console.log(`  ${id}:`);
      issues.forEach(issue => console.log(`    - ${issue}`));
    }
  }

  // Sort the final report by keys
  const sortedReport = {};
  Object.keys(report).sort().forEach(key => {
    sortedReport[key] = report[key];
  });

  return {
    lastUpdatedAt: new Date().toISOString(),
    registry: sortedReport,
  };
}

// Main execution
async function main() {
  const githubToken = process.env.GITHUB_TOKEN;

  if (!githubToken) {
    console.error("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  try {
    console.log("Starting registry generation...");
    const result = await parseRegistry(githubToken);

    if (!result) {
      console.error("Failed to generate registry");
      process.exit(1);
    }

    const outputPath = path.join(__dirname, "..", "generated-registry.json");
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    console.log(`Registry generated successfully: ${outputPath}`);
    console.log(`Generated ${Object.keys(result.registry).length} entries`);
  } catch (error) {
    console.error("Error generating registry:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
