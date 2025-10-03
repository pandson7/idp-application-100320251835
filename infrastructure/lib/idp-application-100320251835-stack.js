"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdpApplication100320251835Stack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const s3n = __importStar(require("aws-cdk-lib/aws-s3-notifications"));
class IdpApplication100320251835Stack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const suffix = '100320251835';
        // S3 Bucket for document storage
        const documentBucket = new s3.Bucket(this, `DocumentBucket${suffix}`, {
            bucketName: `idp-documents-${suffix}`,
            cors: [{
                    allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT],
                    allowedOrigins: ['*'],
                    allowedHeaders: ['*'],
                }],
            lifecycleRules: [{
                    id: 'DeleteOldDocuments',
                    expiration: cdk.Duration.days(30),
                }],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // DynamoDB table for processing results
        const resultsTable = new dynamodb.Table(this, `ResultsTable${suffix}`, {
            tableName: `idp-results-${suffix}`,
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PROVISIONED,
            readCapacity: 5,
            writeCapacity: 5,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // Upload Handler Lambda
        const uploadLambda = new lambda.Function(this, `UploadLambda${suffix}`, {
            functionName: `idp-upload-handler-${suffix}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
        const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
        const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
        
        const s3Client = new S3Client({});
        const dynamoClient = new DynamoDBClient({});
        const docClient = DynamoDBDocumentClient.from(dynamoClient);
        
        exports.handler = async (event) => {
          try {
            const { fileName, contentType } = JSON.parse(event.body);
            const documentId = Date.now().toString();
            
            const command = new PutObjectCommand({
              Bucket: process.env.BUCKET_NAME,
              Key: documentId + '-' + fileName,
              ContentType: contentType,
            });
            
            const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
            
            await docClient.send(new PutCommand({
              TableName: process.env.TABLE_NAME,
              Item: {
                documentId,
                fileName,
                status: 'uploaded',
                createdAt: new Date().toISOString(),
              },
            }));
            
            return {
              statusCode: 200,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
              },
              body: JSON.stringify({ 
                uploadUrl,
                documentId 
              }),
            };
          } catch (error) {
            console.error('Error:', error);
            return {
              statusCode: 500,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
              },
              body: JSON.stringify({ error: error.message }),
            };
          }
        };
      `),
            environment: {
                BUCKET_NAME: documentBucket.bucketName,
                TABLE_NAME: resultsTable.tableName,
            },
        });
        // OCR Processor Lambda
        const ocrLambda = new lambda.Function(this, `OcrLambda${suffix}`, {
            functionName: `idp-ocr-processor-${suffix}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(5),
            code: lambda.Code.fromInline(`
        const { TextractClient, AnalyzeDocumentCommand } = require('@aws-sdk/client-textract');
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
        const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
        
        const textractClient = new TextractClient({});
        const dynamoClient = new DynamoDBClient({});
        const docClient = DynamoDBDocumentClient.from(dynamoClient);
        const lambdaClient = new LambdaClient({});
        
        exports.handler = async (event) => {
          const bucket = event.Records[0].s3.bucket.name;
          const key = event.Records[0].s3.object.key;
          const documentId = key.split('-')[0];
          
          try {
            const command = new AnalyzeDocumentCommand({
              Document: {
                S3Object: {
                  Bucket: bucket,
                  Name: key,
                },
              },
              FeatureTypes: ['FORMS'],
            });
            
            const result = await textractClient.send(command);
            
            const keyValuePairs = {};
            let textContent = '';
            
            result.Blocks.forEach(block => {
              if (block.BlockType === 'LINE') {
                textContent += block.Text + ' ';
              }
              if (block.BlockType === 'KEY_VALUE_SET' && block.EntityTypes && block.EntityTypes.includes('KEY')) {
                const key = block.Text || 'Unknown';
                keyValuePairs[key] = 'Extracted';
              }
            });
            
            // If no key-value pairs found, use text content
            if (Object.keys(keyValuePairs).length === 0) {
              keyValuePairs['text_content'] = textContent.trim();
            }
            
            await docClient.send(new UpdateCommand({
              TableName: process.env.TABLE_NAME,
              Key: { documentId },
              UpdateExpression: 'SET ocrResults = :ocr, #status = :status',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':ocr': keyValuePairs,
                ':status': 'ocr_complete',
              },
            }));
            
            // Trigger classification
            await lambdaClient.send(new InvokeCommand({
              FunctionName: process.env.CLASSIFICATION_FUNCTION,
              InvocationType: 'Event',
              Payload: JSON.stringify({ documentId, ocrResults: keyValuePairs }),
            }));
            
          } catch (error) {
            console.error('OCR Error:', error);
            await docClient.send(new UpdateCommand({
              TableName: process.env.TABLE_NAME,
              Key: { documentId },
              UpdateExpression: 'SET #status = :status, errorMessage = :error',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':status': 'ocr_failed',
                ':error': error.message,
              },
            }));
          }
        };
      `),
            environment: {
                TABLE_NAME: resultsTable.tableName,
                CLASSIFICATION_FUNCTION: `idp-classification-processor-${suffix}`,
            },
        });
        // Classification Processor Lambda
        const classificationLambda = new lambda.Function(this, `ClassificationLambda${suffix}`, {
            functionName: `idp-classification-processor-${suffix}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(5),
            code: lambda.Code.fromInline(`
        const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
        const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
        
        const bedrockClient = new BedrockRuntimeClient({});
        const dynamoClient = new DynamoDBClient({});
        const docClient = DynamoDBDocumentClient.from(dynamoClient);
        const lambdaClient = new LambdaClient({});
        
        exports.handler = async (event) => {
          const { documentId, ocrResults } = event;
          
          try {
            const prompt = \`Classify this document into one of these categories: Dietary Supplement, Stationery, Kitchen Supplies, Medicine, Driver License, Invoice, W2, Other. 
            
            Document content: \${JSON.stringify(ocrResults)}
            
            Respond with only the category name.\`;
            
            const command = new InvokeModelCommand({
              modelId: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
              contentType: 'application/json',
              accept: 'application/json',
              body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 100,
                messages: [{
                  role: 'user',
                  content: prompt
                }]
              })
            });
            
            const result = await bedrockClient.send(command);
            const response = JSON.parse(new TextDecoder().decode(result.body));
            const classification = response.content[0].text.trim();
            
            await docClient.send(new UpdateCommand({
              TableName: process.env.TABLE_NAME,
              Key: { documentId },
              UpdateExpression: 'SET classification = :classification, #status = :status',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':classification': classification,
                ':status': 'classification_complete',
              },
            }));
            
            // Trigger summarization
            await lambdaClient.send(new InvokeCommand({
              FunctionName: process.env.SUMMARIZATION_FUNCTION,
              InvocationType: 'Event',
              Payload: JSON.stringify({ documentId, ocrResults }),
            }));
            
          } catch (error) {
            console.error('Classification Error:', error);
            await docClient.send(new UpdateCommand({
              TableName: process.env.TABLE_NAME,
              Key: { documentId },
              UpdateExpression: 'SET classification = :classification, #status = :status',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':classification': 'Other',
                ':status': 'classification_failed',
              },
            }));
          }
        };
      `),
            environment: {
                TABLE_NAME: resultsTable.tableName,
                SUMMARIZATION_FUNCTION: `idp-summarization-processor-${suffix}`,
            },
        });
        // Summarization Processor Lambda
        const summarizationLambda = new lambda.Function(this, `SummarizationLambda${suffix}`, {
            functionName: `idp-summarization-processor-${suffix}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            timeout: cdk.Duration.minutes(5),
            code: lambda.Code.fromInline(`
        const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
        
        const bedrockClient = new BedrockRuntimeClient({});
        const dynamoClient = new DynamoDBClient({});
        const docClient = DynamoDBDocumentClient.from(dynamoClient);
        
        exports.handler = async (event) => {
          const { documentId, ocrResults } = event;
          
          try {
            const prompt = \`Summarize the following document content in 2-3 sentences:
            
            \${JSON.stringify(ocrResults)}\`;
            
            const command = new InvokeModelCommand({
              modelId: 'global.anthropic.claude-sonnet-4-20250514-v1:0',
              contentType: 'application/json',
              accept: 'application/json',
              body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 200,
                messages: [{
                  role: 'user',
                  content: prompt
                }]
              })
            });
            
            const result = await bedrockClient.send(command);
            const response = JSON.parse(new TextDecoder().decode(result.body));
            const summary = response.content[0].text.trim();
            
            await docClient.send(new UpdateCommand({
              TableName: process.env.TABLE_NAME,
              Key: { documentId },
              UpdateExpression: 'SET summary = :summary, #status = :status',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':summary': summary,
                ':status': 'complete',
              },
            }));
            
          } catch (error) {
            console.error('Summarization Error:', error);
            await docClient.send(new UpdateCommand({
              TableName: process.env.TABLE_NAME,
              Key: { documentId },
              UpdateExpression: 'SET #status = :status, errorMessage = :error',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':status': 'summarization_failed',
                ':error': error.message,
              },
            }));
          }
        };
      `),
            environment: {
                TABLE_NAME: resultsTable.tableName,
            },
        });
        // Results Retriever Lambda
        const resultsLambda = new lambda.Function(this, `ResultsLambda${suffix}`, {
            functionName: `idp-results-retriever-${suffix}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
        const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
        
        const dynamoClient = new DynamoDBClient({});
        const docClient = DynamoDBDocumentClient.from(dynamoClient);
        
        exports.handler = async (event) => {
          const documentId = event.pathParameters.documentId;
          
          try {
            const result = await docClient.send(new GetCommand({
              TableName: process.env.TABLE_NAME,
              Key: { documentId },
            }));
            
            return {
              statusCode: 200,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
              },
              body: JSON.stringify(result.Item || {}),
            };
          } catch (error) {
            return {
              statusCode: 500,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
              },
              body: JSON.stringify({ error: error.message }),
            };
          }
        };
      `),
            environment: {
                TABLE_NAME: resultsTable.tableName,
            },
        });
        // Grant permissions
        documentBucket.grantReadWrite(uploadLambda);
        documentBucket.grantRead(ocrLambda);
        resultsTable.grantReadWriteData(uploadLambda);
        resultsTable.grantReadWriteData(ocrLambda);
        resultsTable.grantReadWriteData(classificationLambda);
        resultsTable.grantReadWriteData(summarizationLambda);
        resultsTable.grantReadData(resultsLambda);
        // Grant Textract permissions
        ocrLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['textract:DetectDocumentText', 'textract:AnalyzeDocument'],
            resources: ['*'],
        }));
        // Grant Bedrock permissions
        classificationLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [
                'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0'
            ],
        }));
        summarizationLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [
                'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
                'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0'
            ],
        }));
        // Grant Lambda invoke permissions
        classificationLambda.grantInvoke(ocrLambda);
        summarizationLambda.grantInvoke(classificationLambda);
        // S3 event notification to trigger OCR
        documentBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(ocrLambda));
        // API Gateway
        const api = new apigateway.RestApi(this, `IdpApi${suffix}`, {
            restApiName: `idp-api-${suffix}`,
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: apigateway.Cors.ALL_METHODS,
                allowHeaders: ['Content-Type', 'Authorization'],
            },
        });
        // API Gateway integrations
        const uploadIntegration = new apigateway.LambdaIntegration(uploadLambda);
        const resultsIntegration = new apigateway.LambdaIntegration(resultsLambda);
        api.root.addResource('upload').addMethod('POST', uploadIntegration);
        api.root.addResource('results').addResource('{documentId}').addMethod('GET', resultsIntegration);
        // Outputs
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: api.url,
            description: 'API Gateway URL',
        });
        new cdk.CfnOutput(this, 'BucketName', {
            value: documentBucket.bucketName,
            description: 'S3 Bucket Name',
        });
    }
}
exports.IdpApplication100320251835Stack = IdpApplication100320251835Stack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWRwLWFwcGxpY2F0aW9uLTEwMDMyMDI1MTgzNS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImlkcC1hcHBsaWNhdGlvbi0xMDAzMjAyNTE4MzUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsdURBQXlDO0FBQ3pDLCtEQUFpRDtBQUNqRCxtRUFBcUQ7QUFDckQsdUVBQXlEO0FBQ3pELHlEQUEyQztBQUMzQyxzRUFBd0Q7QUFHeEQsTUFBYSwrQkFBZ0MsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM1RCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sTUFBTSxHQUFHLGNBQWMsQ0FBQztRQUU5QixpQ0FBaUM7UUFDakMsTUFBTSxjQUFjLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxpQkFBaUIsTUFBTSxFQUFFLEVBQUU7WUFDcEUsVUFBVSxFQUFFLGlCQUFpQixNQUFNLEVBQUU7WUFDckMsSUFBSSxFQUFFLENBQUM7b0JBQ0wsY0FBYyxFQUFFLENBQUMsRUFBRSxDQUFDLFdBQVcsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUM7b0JBQzdFLGNBQWMsRUFBRSxDQUFDLEdBQUcsQ0FBQztvQkFDckIsY0FBYyxFQUFFLENBQUMsR0FBRyxDQUFDO2lCQUN0QixDQUFDO1lBQ0YsY0FBYyxFQUFFLENBQUM7b0JBQ2YsRUFBRSxFQUFFLG9CQUFvQjtvQkFDeEIsVUFBVSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztpQkFDbEMsQ0FBQztZQUNGLGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxD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QUM7Q0FDRjtBQWxkRCwwRUFrZEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gJ2F3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5JztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHMzbiBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtbm90aWZpY2F0aW9ucyc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGNsYXNzIElkcEFwcGxpY2F0aW9uMTAwMzIwMjUxODM1U3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBzdWZmaXggPSAnMTAwMzIwMjUxODM1JztcblxuICAgIC8vIFMzIEJ1Y2tldCBmb3IgZG9jdW1lbnQgc3RvcmFnZVxuICAgIGNvbnN0IGRvY3VtZW50QnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBgRG9jdW1lbnRCdWNrZXQke3N1ZmZpeH1gLCB7XG4gICAgICBidWNrZXROYW1lOiBgaWRwLWRvY3VtZW50cy0ke3N1ZmZpeH1gLFxuICAgICAgY29yczogW3tcbiAgICAgICAgYWxsb3dlZE1ldGhvZHM6IFtzMy5IdHRwTWV0aG9kcy5HRVQsIHMzLkh0dHBNZXRob2RzLlBPU1QsIHMzLkh0dHBNZXRob2RzLlBVVF0sXG4gICAgICAgIGFsbG93ZWRPcmlnaW5zOiBbJyonXSxcbiAgICAgICAgYWxsb3dlZEhlYWRlcnM6IFsnKiddLFxuICAgICAgfV0sXG4gICAgICBsaWZlY3ljbGVSdWxlczogW3tcbiAgICAgICAgaWQ6ICdEZWxldGVPbGREb2N1bWVudHMnLFxuICAgICAgICBleHBpcmF0aW9uOiBjZGsuRHVyYXRpb24uZGF5cygzMCksXG4gICAgICB9XSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyBEeW5hbW9EQiB0YWJsZSBmb3IgcHJvY2Vzc2luZyByZXN1bHRzXG4gICAgY29uc3QgcmVzdWx0c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIGBSZXN1bHRzVGFibGUke3N1ZmZpeH1gLCB7XG4gICAgICB0YWJsZU5hbWU6IGBpZHAtcmVzdWx0cy0ke3N1ZmZpeH1gLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdkb2N1bWVudElkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRCxcbiAgICAgIHJlYWRDYXBhY2l0eTogNSxcbiAgICAgIHdyaXRlQ2FwYWNpdHk6IDUsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgIH0pO1xuXG4gICAgLy8gVXBsb2FkIEhhbmRsZXIgTGFtYmRhXG4gICAgY29uc3QgdXBsb2FkTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBgVXBsb2FkTGFtYmRhJHtzdWZmaXh9YCwge1xuICAgICAgZnVuY3Rpb25OYW1lOiBgaWRwLXVwbG9hZC1oYW5kbGVyLSR7c3VmZml4fWAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMThfWCxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxuICAgICAgICBjb25zdCB7IFMzQ2xpZW50LCBQdXRPYmplY3RDb21tYW5kIH0gPSByZXF1aXJlKCdAYXdzLXNkay9jbGllbnQtczMnKTtcbiAgICAgICAgY29uc3QgeyBnZXRTaWduZWRVcmwgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL3MzLXJlcXVlc3QtcHJlc2lnbmVyJyk7XG4gICAgICAgIGNvbnN0IHsgRHluYW1vREJDbGllbnQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYicpO1xuICAgICAgICBjb25zdCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFB1dENvbW1hbmQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYicpO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgczNDbGllbnQgPSBuZXcgUzNDbGllbnQoe30pO1xuICAgICAgICBjb25zdCBkeW5hbW9DbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuICAgICAgICBjb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZHluYW1vQ2xpZW50KTtcbiAgICAgICAgXG4gICAgICAgIGV4cG9ydHMuaGFuZGxlciA9IGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB7IGZpbGVOYW1lLCBjb250ZW50VHlwZSB9ID0gSlNPTi5wYXJzZShldmVudC5ib2R5KTtcbiAgICAgICAgICAgIGNvbnN0IGRvY3VtZW50SWQgPSBEYXRlLm5vdygpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgUHV0T2JqZWN0Q29tbWFuZCh7XG4gICAgICAgICAgICAgIEJ1Y2tldDogcHJvY2Vzcy5lbnYuQlVDS0VUX05BTUUsXG4gICAgICAgICAgICAgIEtleTogZG9jdW1lbnRJZCArICctJyArIGZpbGVOYW1lLFxuICAgICAgICAgICAgICBDb250ZW50VHlwZTogY29udGVudFR5cGUsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgdXBsb2FkVXJsID0gYXdhaXQgZ2V0U2lnbmVkVXJsKHMzQ2xpZW50LCBjb21tYW5kLCB7IGV4cGlyZXNJbjogMzAwIH0pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgICAgICAgICAgIFRhYmxlTmFtZTogcHJvY2Vzcy5lbnYuVEFCTEVfTkFNRSxcbiAgICAgICAgICAgICAgSXRlbToge1xuICAgICAgICAgICAgICAgIGRvY3VtZW50SWQsXG4gICAgICAgICAgICAgICAgZmlsZU5hbWUsXG4gICAgICAgICAgICAgICAgc3RhdHVzOiAndXBsb2FkZWQnLFxuICAgICAgICAgICAgICAgIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgXG4gICAgICAgICAgICAgICAgdXBsb2FkVXJsLFxuICAgICAgICAgICAgICAgIGRvY3VtZW50SWQgXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycyc6ICdDb250ZW50LVR5cGUnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlcnJvci5tZXNzYWdlIH0pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICBgKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIEJVQ0tFVF9OQU1FOiBkb2N1bWVudEJ1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICBUQUJMRV9OQU1FOiByZXN1bHRzVGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIE9DUiBQcm9jZXNzb3IgTGFtYmRhXG4gICAgY29uc3Qgb2NyTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBgT2NyTGFtYmRhJHtzdWZmaXh9YCwge1xuICAgICAgZnVuY3Rpb25OYW1lOiBgaWRwLW9jci1wcm9jZXNzb3ItJHtzdWZmaXh9YCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xOF9YLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbiAgICAgICAgY29uc3QgeyBUZXh0cmFjdENsaWVudCwgQW5hbHl6ZURvY3VtZW50Q29tbWFuZCB9ID0gcmVxdWlyZSgnQGF3cy1zZGsvY2xpZW50LXRleHRyYWN0Jyk7XG4gICAgICAgIGNvbnN0IHsgRHluYW1vREJDbGllbnQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYicpO1xuICAgICAgICBjb25zdCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFVwZGF0ZUNvbW1hbmQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYicpO1xuICAgICAgICBjb25zdCB7IExhbWJkYUNsaWVudCwgSW52b2tlQ29tbWFuZCB9ID0gcmVxdWlyZSgnQGF3cy1zZGsvY2xpZW50LWxhbWJkYScpO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgdGV4dHJhY3RDbGllbnQgPSBuZXcgVGV4dHJhY3RDbGllbnQoe30pO1xuICAgICAgICBjb25zdCBkeW5hbW9DbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuICAgICAgICBjb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZHluYW1vQ2xpZW50KTtcbiAgICAgICAgY29uc3QgbGFtYmRhQ2xpZW50ID0gbmV3IExhbWJkYUNsaWVudCh7fSk7XG4gICAgICAgIFxuICAgICAgICBleHBvcnRzLmhhbmRsZXIgPSBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgICAgICBjb25zdCBidWNrZXQgPSBldmVudC5SZWNvcmRzWzBdLnMzLmJ1Y2tldC5uYW1lO1xuICAgICAgICAgIGNvbnN0IGtleSA9IGV2ZW50LlJlY29yZHNbMF0uczMub2JqZWN0LmtleTtcbiAgICAgICAgICBjb25zdCBkb2N1bWVudElkID0ga2V5LnNwbGl0KCctJylbMF07XG4gICAgICAgICAgXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgQW5hbHl6ZURvY3VtZW50Q29tbWFuZCh7XG4gICAgICAgICAgICAgIERvY3VtZW50OiB7XG4gICAgICAgICAgICAgICAgUzNPYmplY3Q6IHtcbiAgICAgICAgICAgICAgICAgIEJ1Y2tldDogYnVja2V0LFxuICAgICAgICAgICAgICAgICAgTmFtZToga2V5LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIEZlYXR1cmVUeXBlczogWydGT1JNUyddLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRleHRyYWN0Q2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnN0IGtleVZhbHVlUGFpcnMgPSB7fTtcbiAgICAgICAgICAgIGxldCB0ZXh0Q29udGVudCA9ICcnO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXN1bHQuQmxvY2tzLmZvckVhY2goYmxvY2sgPT4ge1xuICAgICAgICAgICAgICBpZiAoYmxvY2suQmxvY2tUeXBlID09PSAnTElORScpIHtcbiAgICAgICAgICAgICAgICB0ZXh0Q29udGVudCArPSBibG9jay5UZXh0ICsgJyAnO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmIChibG9jay5CbG9ja1R5cGUgPT09ICdLRVlfVkFMVUVfU0VUJyAmJiBibG9jay5FbnRpdHlUeXBlcyAmJiBibG9jay5FbnRpdHlUeXBlcy5pbmNsdWRlcygnS0VZJykpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBrZXkgPSBibG9jay5UZXh0IHx8ICdVbmtub3duJztcbiAgICAgICAgICAgICAgICBrZXlWYWx1ZVBhaXJzW2tleV0gPSAnRXh0cmFjdGVkJztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vIElmIG5vIGtleS12YWx1ZSBwYWlycyBmb3VuZCwgdXNlIHRleHQgY29udGVudFxuICAgICAgICAgICAgaWYgKE9iamVjdC5rZXlzKGtleVZhbHVlUGFpcnMpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICBrZXlWYWx1ZVBhaXJzWyd0ZXh0X2NvbnRlbnQnXSA9IHRleHRDb250ZW50LnRyaW0oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgICAgICAgICBUYWJsZU5hbWU6IHByb2Nlc3MuZW52LlRBQkxFX05BTUUsXG4gICAgICAgICAgICAgIEtleTogeyBkb2N1bWVudElkIH0sXG4gICAgICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdTRVQgb2NyUmVzdWx0cyA9IDpvY3IsICNzdGF0dXMgPSA6c3RhdHVzJyxcbiAgICAgICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7ICcjc3RhdHVzJzogJ3N0YXR1cycgfSxcbiAgICAgICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICAgICAgICc6b2NyJzoga2V5VmFsdWVQYWlycyxcbiAgICAgICAgICAgICAgICAnOnN0YXR1cyc6ICdvY3JfY29tcGxldGUnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBUcmlnZ2VyIGNsYXNzaWZpY2F0aW9uXG4gICAgICAgICAgICBhd2FpdCBsYW1iZGFDbGllbnQuc2VuZChuZXcgSW52b2tlQ29tbWFuZCh7XG4gICAgICAgICAgICAgIEZ1bmN0aW9uTmFtZTogcHJvY2Vzcy5lbnYuQ0xBU1NJRklDQVRJT05fRlVOQ1RJT04sXG4gICAgICAgICAgICAgIEludm9jYXRpb25UeXBlOiAnRXZlbnQnLFxuICAgICAgICAgICAgICBQYXlsb2FkOiBKU09OLnN0cmluZ2lmeSh7IGRvY3VtZW50SWQsIG9jclJlc3VsdHM6IGtleVZhbHVlUGFpcnMgfSksXG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignT0NSIEVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgICAgICAgICAgVGFibGVOYW1lOiBwcm9jZXNzLmVudi5UQUJMRV9OQU1FLFxuICAgICAgICAgICAgICBLZXk6IHsgZG9jdW1lbnRJZCB9LFxuICAgICAgICAgICAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUICNzdGF0dXMgPSA6c3RhdHVzLCBlcnJvck1lc3NhZ2UgPSA6ZXJyb3InLFxuICAgICAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHsgJyNzdGF0dXMnOiAnc3RhdHVzJyB9LFxuICAgICAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgICAgICAgJzpzdGF0dXMnOiAnb2NyX2ZhaWxlZCcsXG4gICAgICAgICAgICAgICAgJzplcnJvcic6IGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgfVxuICAgICAgICB9O1xuICAgICAgYCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBUQUJMRV9OQU1FOiByZXN1bHRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBDTEFTU0lGSUNBVElPTl9GVU5DVElPTjogYGlkcC1jbGFzc2lmaWNhdGlvbi1wcm9jZXNzb3ItJHtzdWZmaXh9YCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyBDbGFzc2lmaWNhdGlvbiBQcm9jZXNzb3IgTGFtYmRhXG4gICAgY29uc3QgY2xhc3NpZmljYXRpb25MYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIGBDbGFzc2lmaWNhdGlvbkxhbWJkYSR7c3VmZml4fWAsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYGlkcC1jbGFzc2lmaWNhdGlvbi1wcm9jZXNzb3ItJHtzdWZmaXh9YCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xOF9YLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoNSksXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbiAgICAgICAgY29uc3QgeyBCZWRyb2NrUnVudGltZUNsaWVudCwgSW52b2tlTW9kZWxDb21tYW5kIH0gPSByZXF1aXJlKCdAYXdzLXNkay9jbGllbnQtYmVkcm9jay1ydW50aW1lJyk7XG4gICAgICAgIGNvbnN0IHsgRHluYW1vREJDbGllbnQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYicpO1xuICAgICAgICBjb25zdCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFVwZGF0ZUNvbW1hbmQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYicpO1xuICAgICAgICBjb25zdCB7IExhbWJkYUNsaWVudCwgSW52b2tlQ29tbWFuZCB9ID0gcmVxdWlyZSgnQGF3cy1zZGsvY2xpZW50LWxhbWJkYScpO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgYmVkcm9ja0NsaWVudCA9IG5ldyBCZWRyb2NrUnVudGltZUNsaWVudCh7fSk7XG4gICAgICAgIGNvbnN0IGR5bmFtb0NsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG4gICAgICAgIGNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkeW5hbW9DbGllbnQpO1xuICAgICAgICBjb25zdCBsYW1iZGFDbGllbnQgPSBuZXcgTGFtYmRhQ2xpZW50KHt9KTtcbiAgICAgICAgXG4gICAgICAgIGV4cG9ydHMuaGFuZGxlciA9IGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgZG9jdW1lbnRJZCwgb2NyUmVzdWx0cyB9ID0gZXZlbnQ7XG4gICAgICAgICAgXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHByb21wdCA9IFxcYENsYXNzaWZ5IHRoaXMgZG9jdW1lbnQgaW50byBvbmUgb2YgdGhlc2UgY2F0ZWdvcmllczogRGlldGFyeSBTdXBwbGVtZW50LCBTdGF0aW9uZXJ5LCBLaXRjaGVuIFN1cHBsaWVzLCBNZWRpY2luZSwgRHJpdmVyIExpY2Vuc2UsIEludm9pY2UsIFcyLCBPdGhlci4gXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIERvY3VtZW50IGNvbnRlbnQ6IFxcJHtKU09OLnN0cmluZ2lmeShvY3JSZXN1bHRzKX1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgUmVzcG9uZCB3aXRoIG9ubHkgdGhlIGNhdGVnb3J5IG5hbWUuXFxgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCBjb21tYW5kID0gbmV3IEludm9rZU1vZGVsQ29tbWFuZCh7XG4gICAgICAgICAgICAgIG1vZGVsSWQ6ICdnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowJyxcbiAgICAgICAgICAgICAgY29udGVudFR5cGU6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAgICAgYWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICBhbnRocm9waWNfdmVyc2lvbjogJ2JlZHJvY2stMjAyMy0wNS0zMScsXG4gICAgICAgICAgICAgICAgbWF4X3Rva2VuczogMTAwLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2VzOiBbe1xuICAgICAgICAgICAgICAgICAgcm9sZTogJ3VzZXInLFxuICAgICAgICAgICAgICAgICAgY29udGVudDogcHJvbXB0XG4gICAgICAgICAgICAgICAgfV1cbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBiZWRyb2NrQ2xpZW50LnNlbmQoY29tbWFuZCk7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZSA9IEpTT04ucGFyc2UobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKHJlc3VsdC5ib2R5KSk7XG4gICAgICAgICAgICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IHJlc3BvbnNlLmNvbnRlbnRbMF0udGV4dC50cmltKCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgICAgICAgICAgVGFibGVOYW1lOiBwcm9jZXNzLmVudi5UQUJMRV9OQU1FLFxuICAgICAgICAgICAgICBLZXk6IHsgZG9jdW1lbnRJZCB9LFxuICAgICAgICAgICAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUIGNsYXNzaWZpY2F0aW9uID0gOmNsYXNzaWZpY2F0aW9uLCAjc3RhdHVzID0gOnN0YXR1cycsXG4gICAgICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAgICAgICAnOmNsYXNzaWZpY2F0aW9uJzogY2xhc3NpZmljYXRpb24sXG4gICAgICAgICAgICAgICAgJzpzdGF0dXMnOiAnY2xhc3NpZmljYXRpb25fY29tcGxldGUnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvLyBUcmlnZ2VyIHN1bW1hcml6YXRpb25cbiAgICAgICAgICAgIGF3YWl0IGxhbWJkYUNsaWVudC5zZW5kKG5ldyBJbnZva2VDb21tYW5kKHtcbiAgICAgICAgICAgICAgRnVuY3Rpb25OYW1lOiBwcm9jZXNzLmVudi5TVU1NQVJJWkFUSU9OX0ZVTkNUSU9OLFxuICAgICAgICAgICAgICBJbnZvY2F0aW9uVHlwZTogJ0V2ZW50JyxcbiAgICAgICAgICAgICAgUGF5bG9hZDogSlNPTi5zdHJpbmdpZnkoeyBkb2N1bWVudElkLCBvY3JSZXN1bHRzIH0pLFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0NsYXNzaWZpY2F0aW9uIEVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgICAgICAgICAgVGFibGVOYW1lOiBwcm9jZXNzLmVudi5UQUJMRV9OQU1FLFxuICAgICAgICAgICAgICBLZXk6IHsgZG9jdW1lbnRJZCB9LFxuICAgICAgICAgICAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUIGNsYXNzaWZpY2F0aW9uID0gOmNsYXNzaWZpY2F0aW9uLCAjc3RhdHVzID0gOnN0YXR1cycsXG4gICAgICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczogeyAnI3N0YXR1cyc6ICdzdGF0dXMnIH0sXG4gICAgICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICAgICAgICAnOmNsYXNzaWZpY2F0aW9uJzogJ090aGVyJyxcbiAgICAgICAgICAgICAgICAnOnN0YXR1cyc6ICdjbGFzc2lmaWNhdGlvbl9mYWlsZWQnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgIGApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEFCTEVfTkFNRTogcmVzdWx0c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgU1VNTUFSSVpBVElPTl9GVU5DVElPTjogYGlkcC1zdW1tYXJpemF0aW9uLXByb2Nlc3Nvci0ke3N1ZmZpeH1gLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFN1bW1hcml6YXRpb24gUHJvY2Vzc29yIExhbWJkYVxuICAgIGNvbnN0IHN1bW1hcml6YXRpb25MYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIGBTdW1tYXJpemF0aW9uTGFtYmRhJHtzdWZmaXh9YCwge1xuICAgICAgZnVuY3Rpb25OYW1lOiBgaWRwLXN1bW1hcml6YXRpb24tcHJvY2Vzc29yLSR7c3VmZml4fWAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMThfWCxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5taW51dGVzKDUpLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG4gICAgICAgIGNvbnN0IHsgQmVkcm9ja1J1bnRpbWVDbGllbnQsIEludm9rZU1vZGVsQ29tbWFuZCB9ID0gcmVxdWlyZSgnQGF3cy1zZGsvY2xpZW50LWJlZHJvY2stcnVudGltZScpO1xuICAgICAgICBjb25zdCB7IER5bmFtb0RCQ2xpZW50IH0gPSByZXF1aXJlKCdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInKTtcbiAgICAgICAgY29uc3QgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBVcGRhdGVDb21tYW5kIH0gPSByZXF1aXJlKCdAYXdzLXNkay9saWItZHluYW1vZGInKTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IGJlZHJvY2tDbGllbnQgPSBuZXcgQmVkcm9ja1J1bnRpbWVDbGllbnQoe30pO1xuICAgICAgICBjb25zdCBkeW5hbW9DbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuICAgICAgICBjb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZHluYW1vQ2xpZW50KTtcbiAgICAgICAgXG4gICAgICAgIGV4cG9ydHMuaGFuZGxlciA9IGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgZG9jdW1lbnRJZCwgb2NyUmVzdWx0cyB9ID0gZXZlbnQ7XG4gICAgICAgICAgXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHByb21wdCA9IFxcYFN1bW1hcml6ZSB0aGUgZm9sbG93aW5nIGRvY3VtZW50IGNvbnRlbnQgaW4gMi0zIHNlbnRlbmNlczpcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgXFwke0pTT04uc3RyaW5naWZ5KG9jclJlc3VsdHMpfVxcYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgY29tbWFuZCA9IG5ldyBJbnZva2VNb2RlbENvbW1hbmQoe1xuICAgICAgICAgICAgICBtb2RlbElkOiAnZ2xvYmFsLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTQtdjE6MCcsXG4gICAgICAgICAgICAgIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICAgICAgIGFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgYW50aHJvcGljX3ZlcnNpb246ICdiZWRyb2NrLTIwMjMtMDUtMzEnLFxuICAgICAgICAgICAgICAgIG1heF90b2tlbnM6IDIwMCxcbiAgICAgICAgICAgICAgICBtZXNzYWdlczogW3tcbiAgICAgICAgICAgICAgICAgIHJvbGU6ICd1c2VyJyxcbiAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6IHByb21wdFxuICAgICAgICAgICAgICAgIH1dXG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYmVkcm9ja0NsaWVudC5zZW5kKGNvbW1hbmQpO1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBKU09OLnBhcnNlKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyZXN1bHQuYm9keSkpO1xuICAgICAgICAgICAgY29uc3Qgc3VtbWFyeSA9IHJlc3BvbnNlLmNvbnRlbnRbMF0udGV4dC50cmltKCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgICAgICAgICAgVGFibGVOYW1lOiBwcm9jZXNzLmVudi5UQUJMRV9OQU1FLFxuICAgICAgICAgICAgICBLZXk6IHsgZG9jdW1lbnRJZCB9LFxuICAgICAgICAgICAgICBVcGRhdGVFeHByZXNzaW9uOiAnU0VUIHN1bW1hcnkgPSA6c3VtbWFyeSwgI3N0YXR1cyA9IDpzdGF0dXMnLFxuICAgICAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHsgJyNzdGF0dXMnOiAnc3RhdHVzJyB9LFxuICAgICAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICAgICAgICAgJzpzdW1tYXJ5Jzogc3VtbWFyeSxcbiAgICAgICAgICAgICAgICAnOnN0YXR1cyc6ICdjb21wbGV0ZScsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcignU3VtbWFyaXphdGlvbiBFcnJvcjonLCBlcnJvcik7XG4gICAgICAgICAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICAgICAgICAgIFRhYmxlTmFtZTogcHJvY2Vzcy5lbnYuVEFCTEVfTkFNRSxcbiAgICAgICAgICAgICAgS2V5OiB7IGRvY3VtZW50SWQgfSxcbiAgICAgICAgICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCAjc3RhdHVzID0gOnN0YXR1cywgZXJyb3JNZXNzYWdlID0gOmVycm9yJyxcbiAgICAgICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7ICcjc3RhdHVzJzogJ3N0YXR1cycgfSxcbiAgICAgICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICAgICAgICc6c3RhdHVzJzogJ3N1bW1hcml6YXRpb25fZmFpbGVkJyxcbiAgICAgICAgICAgICAgICAnOmVycm9yJzogZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICBgKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRBQkxFX05BTUU6IHJlc3VsdHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gUmVzdWx0cyBSZXRyaWV2ZXIgTGFtYmRhXG4gICAgY29uc3QgcmVzdWx0c0xhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgYFJlc3VsdHNMYW1iZGEke3N1ZmZpeH1gLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGBpZHAtcmVzdWx0cy1yZXRyaWV2ZXItJHtzdWZmaXh9YCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xOF9YLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG4gICAgICAgIGNvbnN0IHsgRHluYW1vREJDbGllbnQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYicpO1xuICAgICAgICBjb25zdCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIEdldENvbW1hbmQgfSA9IHJlcXVpcmUoJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYicpO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgZHluYW1vQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbiAgICAgICAgY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGR5bmFtb0NsaWVudCk7XG4gICAgICAgIFxuICAgICAgICBleHBvcnRzLmhhbmRsZXIgPSBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgICAgICBjb25zdCBkb2N1bWVudElkID0gZXZlbnQucGF0aFBhcmFtZXRlcnMuZG9jdW1lbnRJZDtcbiAgICAgICAgICBcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IEdldENvbW1hbmQoe1xuICAgICAgICAgICAgICBUYWJsZU5hbWU6IHByb2Nlc3MuZW52LlRBQkxFX05BTUUsXG4gICAgICAgICAgICAgIEtleTogeyBkb2N1bWVudElkIH0sXG4gICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICAgICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlJyxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocmVzdWx0Lkl0ZW0gfHwge30pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgc3RhdHVzQ29kZTogNTAwLFxuICAgICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycyc6ICdDb250ZW50LVR5cGUnLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlcnJvci5tZXNzYWdlIH0pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICBgKSxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFRBQkxFX05BTUU6IHJlc3VsdHNUYWJsZS50YWJsZU5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgcGVybWlzc2lvbnNcbiAgICBkb2N1bWVudEJ1Y2tldC5ncmFudFJlYWRXcml0ZSh1cGxvYWRMYW1iZGEpO1xuICAgIGRvY3VtZW50QnVja2V0LmdyYW50UmVhZChvY3JMYW1iZGEpO1xuICAgIHJlc3VsdHNUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodXBsb2FkTGFtYmRhKTtcbiAgICByZXN1bHRzVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKG9jckxhbWJkYSk7XG4gICAgcmVzdWx0c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShjbGFzc2lmaWNhdGlvbkxhbWJkYSk7XG4gICAgcmVzdWx0c1RhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShzdW1tYXJpemF0aW9uTGFtYmRhKTtcbiAgICByZXN1bHRzVGFibGUuZ3JhbnRSZWFkRGF0YShyZXN1bHRzTGFtYmRhKTtcblxuICAgIC8vIEdyYW50IFRleHRyYWN0IHBlcm1pc3Npb25zXG4gICAgb2NyTGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ3RleHRyYWN0OkRldGVjdERvY3VtZW50VGV4dCcsICd0ZXh0cmFjdDpBbmFseXplRG9jdW1lbnQnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gR3JhbnQgQmVkcm9jayBwZXJtaXNzaW9uc1xuICAgIGNsYXNzaWZpY2F0aW9uTGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbJ2JlZHJvY2s6SW52b2tlTW9kZWwnXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICAnYXJuOmF3czpiZWRyb2NrOio6KjppbmZlcmVuY2UtcHJvZmlsZS9nbG9iYWwuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowJyxcbiAgICAgICAgJ2Fybjphd3M6YmVkcm9jazoqOjpmb3VuZGF0aW9uLW1vZGVsL2FudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTQtdjE6MCdcbiAgICAgIF0sXG4gICAgfSkpO1xuXG4gICAgc3VtbWFyaXphdGlvbkxhbWJkYS5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogWydiZWRyb2NrOkludm9rZU1vZGVsJ10sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgJ2Fybjphd3M6YmVkcm9jazoqOio6aW5mZXJlbmNlLXByb2ZpbGUvZ2xvYmFsLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTQtdjE6MCcsXG4gICAgICAgICdhcm46YXdzOmJlZHJvY2s6Kjo6Zm91bmRhdGlvbi1tb2RlbC9hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjAnXG4gICAgICBdLFxuICAgIH0pKTtcblxuICAgIC8vIEdyYW50IExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnNcbiAgICBjbGFzc2lmaWNhdGlvbkxhbWJkYS5ncmFudEludm9rZShvY3JMYW1iZGEpO1xuICAgIHN1bW1hcml6YXRpb25MYW1iZGEuZ3JhbnRJbnZva2UoY2xhc3NpZmljYXRpb25MYW1iZGEpO1xuXG4gICAgLy8gUzMgZXZlbnQgbm90aWZpY2F0aW9uIHRvIHRyaWdnZXIgT0NSXG4gICAgZG9jdW1lbnRCdWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsXG4gICAgICBuZXcgczNuLkxhbWJkYURlc3RpbmF0aW9uKG9jckxhbWJkYSlcbiAgICApO1xuXG4gICAgLy8gQVBJIEdhdGV3YXlcbiAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsIGBJZHBBcGkke3N1ZmZpeH1gLCB7XG4gICAgICByZXN0QXBpTmFtZTogYGlkcC1hcGktJHtzdWZmaXh9YCxcbiAgICAgIGRlZmF1bHRDb3JzUHJlZmxpZ2h0T3B0aW9uczoge1xuICAgICAgICBhbGxvd09yaWdpbnM6IGFwaWdhdGV3YXkuQ29ycy5BTExfT1JJR0lOUyxcbiAgICAgICAgYWxsb3dNZXRob2RzOiBhcGlnYXRld2F5LkNvcnMuQUxMX01FVEhPRFMsXG4gICAgICAgIGFsbG93SGVhZGVyczogWydDb250ZW50LVR5cGUnLCAnQXV0aG9yaXphdGlvbiddLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFQSSBHYXRld2F5IGludGVncmF0aW9uc1xuICAgIGNvbnN0IHVwbG9hZEludGVncmF0aW9uID0gbmV3IGFwaWdhdGV3YXkuTGFtYmRhSW50ZWdyYXRpb24odXBsb2FkTGFtYmRhKTtcbiAgICBjb25zdCByZXN1bHRzSW50ZWdyYXRpb24gPSBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihyZXN1bHRzTGFtYmRhKTtcblxuICAgIGFwaS5yb290LmFkZFJlc291cmNlKCd1cGxvYWQnKS5hZGRNZXRob2QoJ1BPU1QnLCB1cGxvYWRJbnRlZ3JhdGlvbik7XG4gICAgYXBpLnJvb3QuYWRkUmVzb3VyY2UoJ3Jlc3VsdHMnKS5hZGRSZXNvdXJjZSgne2RvY3VtZW50SWR9JykuYWRkTWV0aG9kKCdHRVQnLCByZXN1bHRzSW50ZWdyYXRpb24pO1xuXG4gICAgLy8gT3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLnVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIEdhdGV3YXkgVVJMJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdCdWNrZXROYW1lJywge1xuICAgICAgdmFsdWU6IGRvY3VtZW50QnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ1MzIEJ1Y2tldCBOYW1lJyxcbiAgICB9KTtcbiAgfVxufVxuIl19