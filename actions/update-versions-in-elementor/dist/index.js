"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// main.ts
var core = __toESM(require("@actions/core"));
var github = __toESM(require("@actions/github"));
var import_utils = require("@elementor-editor-github-actions/utils");
var import_zod = require("zod");
var OWNER = "Omerisra6";
var TARGET_REPO = "elementor-packages-test";
var internalBotEmail = "internal@elementor.com";
async function run() {
  try {
    const inputs = parseInputs();
    const { targetBranch, packageDirectories, token } = inputs;
    const octokit = github.getOctokit(token);
    const currentRepo = github.context.repo;
    const packageVersions = await core.group("Reading package versions from GitHub API", async () => {
      const versions = /* @__PURE__ */ new Map();
      for (const parentDir of packageDirectories) {
        try {
          const packagesList = await getPackageDirectories(octokit, parentDir, targetBranch);
          for (const packageDir of packagesList) {
            try {
              const fullPath = `${parentDir}/${packageDir}/package.json`;
              const response = await octokit.rest.repos.getContent({
                owner: OWNER,
                repo: TARGET_REPO,
                path: fullPath,
                ref: targetBranch
              });
              if ("content" in response.data && "encoding" in response.data) {
                const content = Buffer.from(response.data.content, response.data.encoding).toString();
                const packageJson = JSON.parse(content);
                const packageName = packageJson.name;
                versions.set(packageName, packageJson.version);
                core.info(`Found version ${packageJson.version} for package ${packageName}`);
              } else {
                core.warning(`Unexpected response format for ${fullPath}`);
              }
            } catch (error) {
              core.warning(`Failed to fetch package.json for directory: packages/${parentDir}/${packageDir}: ${error}`);
            }
          }
        } catch (error) {
          core.warning(`Failed to process parent directory: ${parentDir}: ${error}`);
        }
      }
      return versions;
    });
    const corePackageJsonPath = "package.json";
    let corePackageJsonContent = "";
    let corePackageJsonSha = "";
    await core.group("Fetching core package.json", async () => {
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner: currentRepo.owner,
          repo: currentRepo.repo,
          path: corePackageJsonPath,
          ref: targetBranch
        });
        if (!("content" in data) || !("sha" in data)) {
          throw new Error("Unexpected response format when fetching package.json");
        }
        corePackageJsonContent = Buffer.from(data.content, data.encoding).toString();
        corePackageJsonSha = data.sha;
        core.info("Successfully fetched core package.json");
      } catch (error) {
        throw new Error(`Failed to fetch core package.json: ${error}`);
      }
    });
    let hasUpdates = false;
    let updatedPackageJson;
    await core.group("Updating versions in core package.json", async () => {
      try {
        updatedPackageJson = JSON.parse(corePackageJsonContent);
        for (const [packagePath, version] of packageVersions.entries()) {
          const packageName = packagePath.split("/").pop() || "";
          const packageFullName = `@elementor/${packageName}`;
          if (updatedPackageJson.dependencies?.[packageFullName]) {
            const currentVersion = updatedPackageJson.dependencies[packageFullName];
            updatedPackageJson.dependencies[packageFullName] = version;
            hasUpdates = true;
            core.info(`Updated dependency ${packageFullName} from ${currentVersion} to ${version}`);
          } else if (updatedPackageJson.devDependencies?.[packageFullName]) {
            const currentVersion = updatedPackageJson.devDependencies[packageFullName];
            updatedPackageJson.devDependencies[packageFullName] = version;
            hasUpdates = true;
            core.info(`Updated devDependency ${packageFullName} from ${currentVersion} to ${version}`);
          } else {
            core.warning(`Package ${packageFullName} not found in dependencies or devDependencies`);
          }
        }
        if (!hasUpdates) {
          core.info("No packages needed to be updated in core package.json");
          return;
        }
        core.info("Updated core package.json with new versions");
      } catch (error) {
        throw new Error(`Failed to update core package.json: ${error}`);
      }
    });
    if (hasUpdates) {
      await core.group("Committing changes to repository", async () => {
        try {
          const { data: refData } = await octokit.rest.git.getRef({
            owner: currentRepo.owner,
            repo: currentRepo.repo,
            ref: `heads/${targetBranch}`
          });
          const currentSha = refData.object.sha;
          core.info(`Current ref SHA: ${currentSha}`);
          const content = JSON.stringify(updatedPackageJson, null, 2) + "\n";
          await octokit.rest.repos.createOrUpdateFileContents({
            owner: currentRepo.owner,
            repo: currentRepo.repo,
            path: corePackageJsonPath,
            message: "chore: update package versions",
            content: Buffer.from(content).toString("base64"),
            sha: corePackageJsonSha,
            branch: targetBranch,
            committer: {
              name: "GitHub Actions",
              email: internalBotEmail
            }
          });
          core.info(`Successfully committed changes to ${targetBranch}`);
        } catch (error) {
          throw new Error(`Failed to commit changes: ${error}`);
        }
      });
      core.info("\u2705 Successfully updated package versions in the repository");
    } else {
      core.info("\u2705 No updates were needed in the repository");
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unknown error occurred");
    }
  }
}
async function getPackageDirectories(octokit, parentDir, targetBranch) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner: OWNER,
      repo: TARGET_REPO,
      path: parentDir,
      ref: targetBranch
    });
    if (Array.isArray(response.data)) {
      return response.data.filter((item) => item.type === "dir").map((item) => item.name);
    }
    core.warning(`Unexpected response format for ${parentDir}`);
    return [];
  } catch (error) {
    core.warning(`Failed to list directories in ${parentDir}: ${error}`);
    return [];
  }
}
function parseInputs() {
  try {
    const parsed = import_zod.z.object({
      targetBranch: import_zod.z.string().default("main"),
      packageDirectories: import_zod.z.array(import_zod.z.string()).default(["packages"]),
      token: import_zod.z.string()
    }).parse({
      targetBranch: (0, import_utils.getStringInput)("target-branch"),
      packageDirectories: (0, import_utils.getArrayInput)("package-directories"),
      token: (0, import_utils.getStringInput)("token")
    });
    return parsed;
  } catch (error) {
    let message = "Failed to parse inputs";
    if (error instanceof import_zod.z.ZodError) {
      message = `${message}: ${error.errors.map((e) => `${e.path.join(", ")} - ${e.message}`).join("\n")}`;
    }
    throw new Error(message, { cause: error });
  }
}

// index.ts
void run();
