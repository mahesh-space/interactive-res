import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";

// Create a Pulumi config instance
const config = new pulumi.Config();

// Get configuration values
const region = config.require("aws:region");
const sitePath = config.require("sitePath");
const indexDocument = config.require("indexDocument");
const errorDocument = config.require("errorDocument");
const domainName = config.get("domain") || "interactive-resume";

// Create an S3 bucket for the static website
const siteBucket = new aws.s3.Bucket(`${domainName}-bucket`, {
    website: {
        indexDocument: indexDocument,
        errorDocument: errorDocument,
    },
    acl: "private",
    tags: {
        Project: "interactive-resume",
        ManagedBy: "Pulumi",
    },
});

// Upload all files from the build directory
const files = require("fs").readdirSync(path.join(__dirname, sitePath));
files.forEach((file: string) => {
    new aws.s3.BucketObject(file, {
        bucket: siteBucket.id,
        source: new pulumi.asset.FileAsset(path.join(__dirname, sitePath, file)),
        contentType: getContentType(file),
    });
});

// Create CloudFront Origin Access Identity
const oai = new aws.cloudfront.OriginAccessIdentity(`${domainName}-oai`, {
    comment: "OAI for interactive resume",
});

// Create CloudFront distribution
const cdn = new aws.cloudfront.Distribution(`${domainName}-cdn`, {
    enabled: true,
    aliases: domainName !== "interactive-resume" ? [domainName] : undefined,
    origins: [{
        originId: siteBucket.arn,
        domainName: siteBucket.websiteEndpoint,
        s3OriginConfig: {
            originAccessIdentity: oai.cloudfrontAccessIdentityPath,
        },
    }],
    defaultCacheBehavior: {
        targetOriginId: siteBucket.arn,
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
            queryString: false,
            cookies: { forward: "none" },
        },
        minTtl: 0,
        defaultTtl: 3600,
        maxTtl: 86400,
        compress: true,
    },
    priceClass: "PriceClass_100",
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        cloudfrontDefaultCertificate: domainName === "interactive-resume",
        acmCertificateArn: domainName !== "interactive-resume" 
            ? config.requireSecret("certificateArn") 
            : undefined,
        sslSupportMethod: "sni-only",
    },
    customErrorResponses: [{
        errorCode: 404,
        responseCode: 404,
        responsePagePath: `/${errorDocument}`,
    }],
    tags: {
        Project: "interactive-resume",
    },
});

// Create S3 bucket policy to allow CloudFront access
new aws.s3.BucketPolicy(`${domainName}-bucket-policy`, {
    bucket: siteBucket.id,
    policy: pulumi.all([oai.iamArn, siteBucket.arn]).apply(([oaiArn, bucketArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: {
                AWS: oaiArn,
            },
            Action: "s3:GetObject",
            Resource: `${bucketArn}/*`,
        }],
    })),
});

// Helper function to determine content type
function getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case ".html": return "text/html";
        case ".css": return "text/css";
        case ".js": return "application/javascript";
        case ".json": return "application/json";
        case ".png": return "image/png";
        case ".jpg": case ".jpeg": return "image/jpeg";
        case ".svg": return "image/svg+xml";
        case ".webp": return "image/webp";
        case ".woff": return "font/woff";
        case ".woff2": return "font/woff2";
        default: return "application/octet-stream";
    }
}

// Export the CloudFront distribution URL and other useful outputs
export const outputs = {
    bucketName: siteBucket.id,
    bucketEndpoint: siteBucket.websiteEndpoint,
    cloudFrontDomain: cdn.domainName,
    websiteUrl: domainName === "interactive-resume"
        ? pulumi.interpolate`https://${cdn.domainName}`
        : pulumi.interpolate`https://${domainName}`,
    s3WebsiteUrl: pulumi.interpolate`http://${siteBucket.websiteEndpoint}`,
};