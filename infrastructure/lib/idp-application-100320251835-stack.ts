import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';

export class IdpApplication100320251835Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
    documentBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ocrLambda)
    );

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
