import * as core from '@actions/core';
import * as github from '@actions/github';
import { getArrayInput, getStringInput } from '@elementor-editor-github-actions/utils';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as exec from '@actions/exec';

const PACKAGES_OWNER = 'Omerisra6';
const PACKAGES_REPO = 'elementor-packages-test';
const internalBotEmail = 'internal@elementor.com';

export async function run() {
        const inputs = parseInputs();
        const { targetBranch, packageDirectories, token } = inputs;

        const octokit = github.getOctokit(token);

        const packageVersions = await core.group('Reading package versions from GitHub API', async () => {
            const versions = new Map<string, string>();

            for (const parentDir of packageDirectories) {
                const packagesList = await getPackageDirectories(octokit, parentDir, targetBranch);

                if (packagesList.length === 0) {
                    core.info(`No package directories found in ${parentDir}`);
                    continue;
                }

                core.info(`Found ${packagesList.length} package directories in ${parentDir}`);

                for (const packageDir of packagesList) {
                    const fullPath = `${parentDir}/${packageDir}/package.json`;
                    const response = await octokit.rest.repos.getContent({
                        owner: PACKAGES_OWNER,
                        repo: PACKAGES_REPO,
                        path: fullPath,
                        ref: targetBranch,
                    });

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

        await core.group('Setting up git configuration', async () => {        
            // Set the token for authentication
            const repoUrl = `https://x-access-token:${token}@github.com/${github.context.repo.owner}/${github.context.repo.repo}.git`;
            await exec.exec('git', ['remote', 'set-url', 'origin', repoUrl]);
        });

        let hasUpdates = false;

        await core.group('Updating versions in core package.json', async () => {
            const corePackageJsonPath = 'package.json';
            const corePackageJsonContent = await fs.readFile(corePackageJsonPath, 'utf8');
            let updatedPackageJson = JSON.parse(corePackageJsonContent);

            for (const [packageName, version] of packageVersions.entries()) {
                if (updatedPackageJson.dependencies?.[packageName]) {
                    const currentVersion = updatedPackageJson.dependencies[packageName];
                    updatedPackageJson.dependencies[packageName] = version;
                    hasUpdates = true;
                    core.info(`Updated dependency ${packageName} from ${currentVersion} to ${version}`);
                    continue;
                }

                core.warning(`Package ${packageName} not found in dependencies`);
            }

            if (!hasUpdates) {
                core.info('No packages needed to be updated in core package.json');
                return;
            }

            await fs.writeFile(corePackageJsonPath, JSON.stringify(updatedPackageJson, null, 2) + '\n');
            core.info('Updated core package.json with new versions');
        });

        if (!hasUpdates) {
            core.info('No updates were needed in the repository');
            return;
        }

        await core.group('Installing new dependencies', async () => {
            try {
                core.info('Installing updated dependencies...');
                await exec.exec('npm', ['install', '--package-lock-only']);
                core.info('Successfully installed new dependencies');
            } catch (error) {
                throw new Error(`Failed to install dependencies: ${error}`);
            }
        });

        await core.group('Committing changes to repository', async () => {
            try {
                await exec.exec('git', ['add', 'package.json', 'package-lock.json']);
                
                const { stdout } = await exec.getExecOutput('git', ['status', '--porcelain']);
                
                if (!stdout) {
                    core.info('No changes to commit');
                    return;
                }
                
                await exec.exec('git', ['commit', '-m', 'Tweak: Update package versions']);
                
                // Use the configured remote with token for authentication
                await exec.exec('git', ['push', 'origin', 'HEAD:main']);
                
                core.info(`Successfully committed changes to main branch`);
            } catch (error) {
                core.error(`Git command failed: ${error}`);
                throw new Error(`Failed to commit changes: ${error}`);
            }
        });

        core.info('✅ Successfully updated package versions in the repository');
}

async function getPackageDirectories(
    octokit: ReturnType<typeof github.getOctokit>,
    parentDir: string,
    targetBranch: string
): Promise<string[]> {
    const response = await octokit.rest.repos.getContent({
        owner: PACKAGES_OWNER,
        repo: PACKAGES_REPO,
        path: parentDir,
        ref: targetBranch,
    });

    if (Array.isArray(response.data)) {
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
