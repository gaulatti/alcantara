import { Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';

/**
 * Creates buckets for the stack.
 *
 * @param stack - The stack object.
 * @returns An object containing the created buckets.
 */
const createBuckets = (stack: Stack) => {
  /**
   * Frontend Bucket
   */
  const frontendBucket = new Bucket(stack, `${stack.stackName}FrontendBucket`, {
    bucketName: `${stack.stackName.toLowerCase()}-frontend`,
  });

  return { frontendBucket };
};

export { createBuckets };
