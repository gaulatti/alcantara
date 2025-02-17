import { Duration, Stack } from 'aws-cdk-lib';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { CachePolicy, Distribution, ErrorResponse, OriginAccessIdentity, SecurityPolicyProtocol, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { CnameRecord, HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';

/**
 * Creates a hosted zone using the provided stack and hosted zone ID.
 *
 * @param stack - The stack object.
 * @returns An object containing the created hosted zone.
 */
const createHostedZone = (stack: Stack) => {
  /**
   * HostedZone
   */
  const hostedZone = HostedZone.fromHostedZoneAttributes(stack, `${stack.stackName}HostedZone`, {
    hostedZoneId: process.env.HOSTED_ZONE_ID!,
    zoneName: process.env.HOSTED_ZONE_NAME!,
  });

  return { hostedZone };
};

/**
 * Builds a zone certificate for the given stack and hosted zone.
 *
 * @param stack - The stack object.
 * @returns The built certificate object.
 */
const createZoneCertificate = (stack: Stack) => {
  /**
   * Certificate
   */
  const certificate = Certificate.fromCertificateArn(stack, `${stack.stackName}Certificate'`, process.env.HOSTED_ZONE_CERTIFICATE!);

  return { certificate };
};

/**
 * Creates a CloudFront distribution for the specified stack and S3 bucket.
 *
 * @param stack - The AWS CloudFormation stack.
 * @param bucket - The S3 bucket to be used as the origin source.
 * @param certificate - The SSL certificate to be used by the distribution.
 * @returns The created CloudFront distribution.
 */
const createDistribution = (stack: Stack, s3BucketSource: Bucket, certificate: ICertificate) => {
  /**
   * Represents the CloudFront Origin Access Identity (OAI).
   */
  const originAccessIdentity = new OriginAccessIdentity(stack, `${stack.stackName}DistributionOAI`);

  /**
   * Grants read permissions to the CloudFront Origin Access Identity (OAI).
   */
  s3BucketSource.grantRead(originAccessIdentity);

  /**
   * Represents the CloudFront distribution to serve the React Assets.
   */
  const distribution = new Distribution(stack, `${stack.stackName}Distribution`, {
    defaultBehavior: {
      origin: S3BucketOrigin.withOriginAccessIdentity(s3BucketSource, { originAccessIdentity }),
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
    },
    defaultRootObject: 'index.html',
    domainNames: [`alcantara.${process.env.HOSTED_ZONE_NAME}`],
    certificate,
    minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
    errorResponses: [
      {
        httpStatus: 404,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      } as ErrorResponse,
    ],
  });

  return { distribution };
};

/**
 * Creates a CNAME record for the frontend.
 *
 * @param stack - The AWS CloudFormation stack.
 * @param zone - The hosted zone where the CNAME record will be created.
 * @param distribution - The distribution associated with the CNAME record.
 * @returns An object containing the frontend CNAME record.
 */
const createCNAME = (stack: Stack, zone: IHostedZone, distribution: Distribution) => {
  const record = new CnameRecord(stack, `${stack.stackName}FrontendCNAME`, {
    recordName: 'alcantara',
    zone,
    domainName: distribution.distributionDomainName,
  });

  return { record };
};

export { createCNAME, createDistribution, createHostedZone, createZoneCertificate };
