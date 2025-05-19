import * as core from '@actions/core';
import * as github from '@actions/github';
import { getArrayInput, getStringInput } from '@elementor-editor-github-actions/utils';
import { z } from 'zod';
import * as fs from 'fs/promises';
import exec from '@actions/exec';

const OWNER = 'Omerisra6';
const TARGET_REPO = 'elementor-packages-test';
const internalBotEmail = 'internal@elementor.com';

export async function run() {
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
                // Get the list of package directories within the parent directory
                const packagesList = await getPackageDirectories(octokit, parentDir, targetBranch);

                if (packagesList.length === 0) {
                    core.info(`No package directories found in ${parentDir}`);
                    continue;
                }

                core.info(`Found ${packagesList.length} package directories in ${parentDir}`);

                // For each package directory, fetch the package.json
                for (const packageDir of packagesList) {
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
                }
            }

            return versions;
        });

        // Get current package.json from the repository
        const corePackageJsonPath = 'package.json';
        let corePackageJsonContent = '';

        await core.group('Fetching core package.json', async () => {
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
            core.info('Successfully fetched core package.json');
        });

        // Update versions in package.json
        let hasUpdates = false;
        let updatedPackageJson: any;

        await core.group('Updating versions in core package.json', async () => {
            updatedPackageJson = JSON.parse(corePackageJsonContent);

            for (const [packageName, version] of packageVersions.entries()) {
                if (updatedPackageJson.dependencies?.[packageName]) {
                    const currentVersion = updatedPackageJson.dependencies[packageName];
                    updatedPackageJson.dependencies[packageName] = version;
                    hasUpdates = true;
                    core.info(`Updated dependency ${packageName} from ${currentVersion} to ${version}`);
                }

                core.warning(`Package ${packageName} not found in dependencies`);
            }

            if (!hasUpdates) {
                core.info('No packages needed to be updated in core package.json');
                return;
            }

            core.info('Updated core package.json with new versions');
        });

        if (!hasUpdates) {
            core.info('No updates were needed in the repository');
            return;
        }

        await core.group('Installing new dependencies', async () => {
            try {
                // Create a temporary package.json file with updated dependencies
                const tempPackageJsonPath = 'temp-package.json';
                await fs.writeFile(tempPackageJsonPath, JSON.stringify(updatedPackageJson, null, 2));
                
                    // Run npm install to update the package-lock.json
                    core.info('Installing updated dependencies...');
                    await exec.exec('npm', ['install', '--package-lock-only']);
                    
                    // Clean up temporary file
                    await fs.unlink(tempPackageJsonPath);
                    
                    core.info('Successfully installed new dependencies');
                } catch (error) {
                    throw new Error(`Failed to install dependencies: ${error}`);
                }
            });
            
            await core.group('Committing changes to repository', async () => {
                try {
                    const { data: refData } = await octokit.rest.git.getRef({
                        owner: currentRepo.owner,
                        repo: currentRepo.repo,
                        ref: `heads/main`
                    });

                    const currentSha = refData.object.sha;
                    core.info(`Current ref SHA: ${currentSha}`);

                    // Prepare package.json content
                    const packageJsonContent = JSON.stringify(updatedPackageJson, null, 2) + '\n';
                    
                    // Get package-lock.json content and SHA
                    const lockFilePath = 'package-lock.json';
                    let lockFileContent = '';
                    let lockFileSha = '';
                    
                    lockFileContent = await fs.readFile(lockFilePath, 'utf8');
                    
                    const { data: lockFileData } = await octokit.rest.repos.getContent({
                        owner: currentRepo.owner,
                        repo: currentRepo.repo,
                        path: lockFilePath,
                        ref: 'main'
                    });
                    
                    if ('sha' in lockFileData) {
                        lockFileSha = lockFileData.sha;
                    }
                    
                    if (lockFileContent && lockFileSha) {
                        const { data: treeData } = await octokit.rest.git.createTree({
                            owner: currentRepo.owner,
                            repo: currentRepo.repo,
                            base_tree: currentSha,
                            tree: [
                                {
                                    path: corePackageJsonPath,
                                    mode: '100644',
                                    type: 'blob',
                                    content: packageJsonContent
                                },
                                {
                                    path: lockFilePath,
                                    mode: '100644',
                                    type: 'blob',
                                    content: lockFileContent
                                }
                            ]
                        });
                        
                        // Create a commit
                        const { data: commitData } = await octokit.rest.git.createCommit({
                            owner: currentRepo.owner,
                            repo: currentRepo.repo,
                            message: 'Tweak: Update package versions',
                            tree: treeData.sha,
                            parents: [currentSha],
                            author: {
                                name: 'GitHub Actions',
                                email: internalBotEmail
                            },
                            committer: {
                                name: 'GitHub Actions',
                                email: internalBotEmail
                            }
                        });
                        
                        // Update the reference
                        await octokit.rest.git.updateRef({
                            owner: currentRepo.owner,
                            repo: currentRepo.repo,
                            ref: 'heads/main',
                            sha: commitData.sha
                        });
                        
                        core.info(`Successfully committed changes to ${targetBranch}`);
                    }
                } catch (error) {
                    throw new Error(`Failed to commit changes: ${error}`);
                }
            });

        core.info('✅ Successfully updated package versions in the repository');
}

/**
 * Get list of package directories within a parent directory
 */
async function getPackageDirectories(
    octokit: ReturnType<typeof github.getOctokit>,
    parentDir: string,
    targetBranch: string
): Promise<string[]> {
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

    return [];
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
