import { Stack } from 'aws-cdk-lib';
import { createGitHubActionsPermissions } from './github-actions';

/**
 * Creates and configures permissions for the given stack.
 *
 * @param stack - The AWS CloudFormation stack to which the permissions will be added.
 * @returns An object containing the created GitHub Actions user permissions.
 */
const createPermissions = (stack: Stack) => {
  /**
   * Creates the permissions for the GitHub Actions autobuild.
   */
  const { githubActionsUser } = createGitHubActionsPermissions(stack);

  return { githubActionsUser };
};

export { createPermissions };
