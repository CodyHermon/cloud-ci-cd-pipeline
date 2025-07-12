import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export class AwsCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `ci-cd-frontend-${this.account}-${this.region}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    const distribution = new cloudfront.Distribution(
      this,
      'FrontendDistribution',
      {
        defaultBehavior: {
          origin: new origins.S3StaticWebsiteOrigin(frontendBucket),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        },
        defaultRootObject: 'index.html',

        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: '/index.html',
            ttl: cdk.Duration.minutes(5),
          },
        ],
      }
    );

    const ecrRepository = new ecr.Repository(this, 'BackendRepository', {
      repositoryName: 'ci-cd-backend',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      imageScanOnPush: true,
    });

    const vpc = new ec2.Vpc(this, 'PipelineVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    const cluster = new ecs.Cluster(this, 'BackendCluster', {
      vpc: vpc,
      clusterName: 'ci-cd-backend-cluster',
      containerInsights: true,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BackendTask', {
      memoryLimitMiB: 512,
      cpu: 256,
      family: 'ci-cd-backend',
    });

    const container = taskDefinition.addContainer('BackendContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'latest'),
      environment: {
        NODE_ENV: 'production',
        PORT: '3001',
        GITHUB_OWNER: process.env.GITHUB_OWNER || 'CodyHermon',
        GITHUB_REPO: process.env.GITHUB_REPO || 'cloud-ci-cd-pipeline',
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'backend-api',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    container.addPortMappings({
      containerPort: 3001,
      protocol: ecs.Protocol.TCP,
    });

    const service = new ecs.FargateService(this, 'BackendService', {
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      serviceName: 'ci-cd-backend-service',
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'BackendALB', {
      vpc: vpc,
      internetFacing: true,
      loadBalancerName: 'ci-cd-backend-alb',
    });

    const listener = alb.addListener('BackendListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    listener.addTargets('BackendTargets', {
      port: 3001,
      targets: [service],
      healthCheck: {
        path: '/api/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        protocol: elbv2.Protocol.HTTP,
      },
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    new cdk.CfnOutput(this, 'ECRRepository', {
      value: ecrRepository.repositoryUri,
      description: 'ECR Repository URI for backend container',
      exportName: 'ECRRepository',
    });

    new cdk.CfnOutput(this, 'FrontendURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Frontend CloudFront URL - Dashboard will be available here',
      exportName: 'FrontendURL',
    });

    new cdk.CfnOutput(this, 'BackendURL', {
      value: `http://${alb.loadBalancerDnsName}`,
      description: 'Backend ALB URL - API will be available here',
      exportName: 'BackendURL',
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: frontendBucket.bucketName,
      description: 'S3 Bucket name for frontend deployment',
      exportName: 'S3BucketName',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster name for backend deployment',
      exportName: 'ClusterName',
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: service.serviceName,
      description: 'ECS Service name for backend deployment',
      exportName: 'ServiceName',
    });
  }
}
