const core = require('@actions/core');
const simpleGit = require('simple-git');
const path = require('path');
const { mkdir } = require('fs').promises;
const { retry } = require('@octokit/plugin-retry');
const { GitHub, getOctokitOptions } = require('@actions/github/lib/utils');
const { createConfig } = require("./common");


const { merge } = require("./merge");
const { createBranch, clone, push, areFilesChanged, getBranchesLocal, checkoutBranch } = require('./git');
const { getReposList, createPr, getRepo } = require('./api-calls');
const { getListOfFilesToReplicate, copyChangedFiles, getListOfReposToIgnore, getBranchName, isInitialized, getBranchesList } = require('./utils');

const triggerEventName = process.env.GITHUB_EVENT_NAME;
const eventPayload = require(process.env.GITHUB_EVENT_PATH);

/* eslint-disable sonarjs/cognitive-complexity */
async function run() {
  const isPush = triggerEventName === 'push';
  if (isPush) core.info('Workflow started on push event');
  const isWorkflowDispatch = triggerEventName === 'workflow_dispatch';
  if (isWorkflowDispatch) core.info('Workflow started on workflow_dispatch event');

  if (!isPush && !isWorkflowDispatch) return core.setFailed('This GitHub Action works only when triggered by "push" or "workflow_dispatch" webhooks.');
  
  core.debug('DEBUG: full payload of the event that triggered the action:');
  core.debug(JSON.stringify(eventPayload, null, 2));

  try {
    /*
     * 0. Setting up necessary variables and getting input specified by workflow user
    */ 
    const gitHubKey = process.env.GITHUB_TOKEN || core.getInput('github_token', { required: true });
    const patternsToIgnore = core.getInput('patterns_to_ignore');
    const patternsToInclude = core.getInput('patterns_to_include');
    const committerUsername = core.getInput('committer_username');
    const committerEmail = core.getInput('committer_email');
    const commitMessage = core.getInput('commit_message');
    const branches = core.getInput('branches');
    const destination = core.getInput('destination');
    const repoNameManual = eventPayload.inputs && eventPayload.inputs.repo_name;

    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

    const octokitWithRetry = GitHub.plugin(retry);
    const octokit = new octokitWithRetry(getOctokitOptions(gitHubKey, {
      // Topics are currently only available using mercy-preview.
      previews: ['mercy-preview'],
    }));

    //Id of commit can be taken only from push event, not workflow_dispatch
    //TODO for now this action is hardcoded to always get commit id of the first commit on the list
    const commitId = triggerEventName === 'push' ? eventPayload.commits[0].id : '';

    /*
     * 1. Getting list of files that must be replicated in other repos by this action
     */    
    const filesToReplicate = await getListOfFilesToReplicate(octokit, commitId, owner, repo, patternsToIgnore, patternsToInclude, triggerEventName);
    //if no files need replication, we just need to stop the workflow from further execution
    if (!filesToReplicate.length) 
      return;

    /*
     * 2. Getting list of all repos owned by the owner/org 
     *    or just replicating to the one provided manually
     */
    let reposList = [];
    if (isWorkflowDispatch && repoNameManual) {
      reposList.push(await getRepo(octokit, owner, repoNameManual));
    } else {
      reposList = await getReposList(octokit, owner);
    }

    /*
     * 3. Getting list of repos that should be ignored
     */
    const ignoredRepositories = getListOfReposToIgnore(repo, reposList, {
      reposToIgnore: core.getInput('repos_to_ignore'),
      topicsToInclude: core.getInput('topics_to_include'),
      excludePrivate: (core.getInput('exclude_private') === 'true'),
      excludeForked: (core.getInput('exclude_forked') === 'true'),
    });

    /*
     * 4. Replication of files in selected repos starts one by one
     */
    for (const repo of reposList) {
      try {
        //start only if repo not on list of ignored
        if (!ignoredRepositories.includes(repo.name)) {        
          core.startGroup(`Started updating ${repo.name} repo`);
          const defaultBranch = repo.defaultBranch;

          /*
           * 4a. Creating folder where repo will be cloned and initializing git client
           */
          const dir = path.join(process.cwd(), './clones', repo.name);
          await mkdir(dir, {recursive: true});
          const git = simpleGit({baseDir: dir});

          /*
           * 4b. Cloning and verification of the repo before replication
           */
          await clone(gitHubKey, repo.url, dir, git); 
          if (!isInitialized(await getBranchesLocal(git), defaultBranch)) {
            core.info('Repo not initialized, skipping it.');
            continue;
          }

          /*
           * 4c. Checking what branches should this action operate on. 
           *     Should it be just default one or the ones provided by the user
           */
          const branchesToOperateOn = await getBranchesList(octokit, owner, repo.name, branches, defaultBranch); 
          if (!branchesToOperateOn.length) {
            core.info('Repo has no branches that the action could operate on');
            continue;
          }

          /*
           * 4d. Per branch operation starts
           */
          for (const branch of branchesToOperateOn) {
            /*
             * 4da. Checkout branch in cloned repo
             */
            const branchName = branch.name;
            await checkoutBranch(branchName, git);

            /*
             * 4db. Creating new branch in cloned repo
             */
            const newBranchName = getBranchName(commitId, branchName);
            await createBranch(newBranchName, git);

            /*
             * 4dc. Replicating files
             */         
            await copyChangedFiles(filesToReplicate, dir, destination);
                  
            //pushing and creating PR only if there are changes detected locally
            if (await areFilesChanged(git)) {
              /*
               * 4ed. Pushing files to custom branch
               */  
              await push(newBranchName, commitMessage, committerUsername, committerEmail, git);
                    
              /*
               * 4fe. Opening a PR
               */  
              const pr = await createPr(octokit, newBranchName, repo.id, commitMessage, branchName);
                    
              core.endGroup();
          
              if (pr) {
                core.info(`Pull Request for ${repo.name} is created (# ${pr.number}) -> ${pr.url}`);


                let { data: pullRequest } = await octokit.pulls.get({
                  owner: repo.owner,
                  repo: repo.name,
                  pull_number: pr.number,
                  headers: { "If-None-Match": "" }
                });
                
                core.info(`Attempting to auto-merge the Pull Request (# ${pr.number}) for ${repo.name}`);

                const config = createConfig(process.env);
                await merge({ config, octokit: octokit }, pullRequest);

              } else {
                core.info(`Unable to create a PR because of timeouts. Create Pull Request manually from the branch ${newBranchName} that was already created in the upstream`);
              }
            } else {
              core.endGroup();
              core.info('Finished with success. No PR was created as no changes were detected');
            }
          }
        }
      } catch (error) {
        core.endGroup();
        core.warning(`Failed replicating files for repo ${repo.name} with error: ${error}`);
        continue;
      }
    }
  } catch (error) {
    core.setFailed(`Action failed because of: ${error}`);
  }
}

run();
