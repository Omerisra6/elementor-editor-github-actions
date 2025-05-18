import * as core from '@actions/core';
import * as github from '@actions/github';
import { getArrayInput, getStringInput } from '@elementor-editor-github-actions/utils';
import { z } from 'zod';

const OWNER = 'Omerisra6';
const TARGET_REPO = 'elementor-packages-test';
const internalBotEmail = 'internal@elementor.com';

export async function run() {
    try {
        const inputs = parseInputs();
        const { targetBranch, packageDirectories, token } = inputs;

        // Initialize GitHub API client
        const octokit = github.getOctokit(token);
        
        // Get current repository context from GitHub context
        const currentRepo = github.context.repo;
        
        // Find and read package versions
        const packageVersions = await core.group('Reading package versions from GitHub API', async () => {
            const versions = new Map<string, string>();

            for (const parentDir of packageDirectories) {
                try {
                    core.info(`Checking directory: ${parentDir} in ${OWNER}/${TARGET_REPO} on branch ${targetBranch}`);
                    
                    // First, check if the parent directory exists
                    try {
                        await octokit.rest.repos.getContent({
                            owner: OWNER,
                            repo: TARGET_REPO,
                            path: parentDir,
                            ref: targetBranch,
                        });
                    } catch (error: any) {
                        if (error.status === 404) {
                            core.info(`Directory not found: ${parentDir} - Please check that this directory exists in ${OWNER}/${TARGET_REPO}`);
                            continue; // Skip to the next parent directory
                        }
                        throw error; // Re-throw other errors
                    }
                    
                    // Get the list of package directories within the parent directory
                    const packagesList = await getPackageDirectories(octokit, parentDir, targetBranch);
                    
                    if (packagesList.length === 0) {
                        core.info(`No package directories found in ${parentDir}`);
                        continue;
                    }

                    core.info(`Found ${packagesList.length} package directories in ${parentDir}`);

                    // For each package directory, fetch the package.json
                    for (const packageDir of packagesList) {
                        try {
                            const fullPath = `${parentDir}/${packageDir}/package.json`;
                            const response = await octokit.rest.repos.getContent({
                                owner: OWNER,
                                repo: TARGET_REPO,
                                path: fullPath,
                                ref: targetBranch,
                            });

                            // GitHub API returns content as base64 encoded
                            if ('content' in response.data && 'encoding' in response.data) {
                                const content = Buffer.from(response.data.content, response.data.encoding as BufferEncoding).toString();
                                const packageJson = JSON.parse(content);
                                const packageName = packageJson.name;
                                versions.set(packageName, packageJson.version);
                                core.info(`Found version ${packageJson.version} for package ${packageName}`);
                            } else {
                                core.warning(`Unexpected response format for ${fullPath}`);
                            }
                        } catch (error) {
                            core.warning(`Failed to fetch package.json for directory: ${parentDir}/${packageDir}: ${error}`);
                        }
                    }
                } catch (error) {
                    core.warning(`Failed to process parent directory: ${parentDir}: ${error}`);
                }
            }

            return versions;
        });

        // Get current package.json from the repository
        const corePackageJsonPath = 'package.json';
        let corePackageJsonContent = '';
        let corePackageJsonSha = '';
        
        await core.group('Fetching core package.json', async () => {
            try {
                const { data } = await octokit.rest.repos.getContent({
                    owner: currentRepo.owner,
                    repo: currentRepo.repo,
                    path: corePackageJsonPath,
                    ref: 'main'
                });
                
                if (!('content' in data) || !('sha' in data)) {
                    throw new Error('Unexpected response format when fetching package.json');
                }
                
                corePackageJsonContent = Buffer.from(data.content, data.encoding as BufferEncoding).toString();
                corePackageJsonSha = data.sha;
                core.info('Successfully fetched core package.json');
            } catch (error) {
                throw new Error(`Failed to fetch core package.json: ${error}`);
            }
        });

        // Update versions in package.json
        let hasUpdates = false;
        let updatedPackageJson: any;
        
        await core.group('Updating versions in core package.json', async () => {
            try {
                updatedPackageJson = JSON.parse(corePackageJsonContent);
                
                // Loop through the versions from the target repo
                for (const [packageName, version] of packageVersions.entries()) {
                    // Extract package name from path (e.g., "packages/package-name" -> "package-name")
                    const packageFullName = packageName;
                    
                    // Check if the package exists in dependencies or devDependencies
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
                    core.info('No packages needed to be updated in core package.json');
                    return;
                }
                
                core.info('Updated core package.json with new versions');
            } catch (error) {
                throw new Error(`Failed to update core package.json: ${error}`);
            }
        });

        // If there are updates, commit the changes
        if (hasUpdates) {
            await core.group('Committing changes to repository', async () => {
                try {
                    // Get the current reference to create commit on top of
                    const { data: refData } = await octokit.rest.git.getRef({
                        owner: currentRepo.owner,
                        repo: currentRepo.repo,
                        ref: `heads/main`
                    });
                    
                    const currentSha = refData.object.sha;
                    core.info(`Current ref SHA: ${currentSha}`);
                    
                    // Create or update the file with the new content
                    const content = JSON.stringify(updatedPackageJson, null, 2) + '\n';
                    
                    await octokit.rest.repos.createOrUpdateFileContents({
                        owner: currentRepo.owner,
                        repo: currentRepo.repo,
                        path: corePackageJsonPath,
                        message: 'chore: update package versions',
                        content: Buffer.from(content).toString('base64'),
                        sha: corePackageJsonSha,
                        branch: 'main',
                        committer: {
                            name: 'GitHub Actions',
                            email: internalBotEmail
                        }
                    });
                    
                    core.info(`Successfully committed changes to ${targetBranch}`);
                } catch (error) {
                    throw new Error(`Failed to commit changes: ${error}`);
                }
            });
            
            core.info('✅ Successfully updated package versions in the repository');
        } else {
            core.info('✅ No updates were needed in the repository');
        }
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        } else {
            core.setFailed('An unknown error occurred');
        }
    }
}

/**
 * Get list of package directories within a parent directory
 */
async function getPackageDirectories(
    octokit: ReturnType<typeof github.getOctokit>,
    parentDir: string,
    targetBranch: string
): Promise<string[]> {
    try {
        const response = await octokit.rest.repos.getContent({
            owner: OWNER,
            repo: TARGET_REPO,
            path: parentDir,
            ref: targetBranch,
        });

        if (Array.isArray(response.data)) {
            // Filter out only the directories
            return response.data
                .filter(item => item.type === 'dir')
                .map(item => item.name);
        }

        core.warning(`Unexpected response format for ${parentDir}`);
        return [];
    } catch (error: any) {
        if (error.status === 404) {
            core.warning(`Failed to list directories in ${parentDir}: Not Found - Directory might not exist or token might not have sufficient permissions`);
        } else {
            core.warning(`Failed to list directories in ${parentDir}: ${error}`);
        }
        return [];
    }
}

function parseInputs() {
    try {
        const parsed = z
            .object({
                targetBranch: z.string().default( 'main' ),
                packageDirectories: z.array(z.string()).default(['packages']),
                token: z.string(),
            })
            .parse({
                targetBranch: getStringInput('target-branch'),
                packageDirectories: getArrayInput('package-directories'),
                token: getStringInput('token'),
            });

        return parsed;
    } catch (error) {
        let message = 'Failed to parse inputs';

        if (error instanceof z.ZodError) {
            message = `${message}: ${error.errors
                .map((e) => `${e.path.join(', ')} - ${e.message}`)
                .join('\n')}`;
        }

        throw new Error(message, { cause: error });
    }
}
