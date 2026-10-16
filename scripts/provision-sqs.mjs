import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/**
 * Provision an isolated FIFO request queue plus FIFO DLQ in LocalStack.
 * Example: bun scripts/provision-sqs.mjs wagering-wallet-test
 */
const baseName = process.argv[2] ?? 'wager-transactions';
if (!/^[A-Za-z0-9_-]{1,64}$/.test(baseName)) {
  throw new Error('Queue prefix must be 1-64 letters, digits, underscore or dash.');
}
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const region = process.env.AWS_REGION ?? 'us-east-1';
const sqs = new SQSClient({
  region,
  endpoint,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

try {
  const dlqName = `${baseName}-dlq.fifo`;
  const dlqResult = await sqs.send(new CreateQueueCommand({
    QueueName: dlqName,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: '60',
      MessageRetentionPeriod: '1209600',
    },
  }));
  if (!dlqResult.QueueUrl) throw new Error('LocalStack returned no DLQ URL');
  const dlqAttributes = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: dlqResult.QueueUrl,
    AttributeNames: ['QueueArn'],
  }));
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('LocalStack returned no DLQ ARN');

  const queueResult = await sqs.send(new CreateQueueCommand({
    QueueName: `${baseName}.fifo`,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: '60',
      ReceiveMessageWaitTimeSeconds: '10',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: 5,
      }),
    },
  }));
  if (!queueResult.QueueUrl) throw new Error('LocalStack returned no queue URL');

  console.log(JSON.stringify({
    queue: `${baseName}.fifo`,
    queueUrl: queueResult.QueueUrl,
    dlq: dlqName,
    dlqUrl: dlqResult.QueueUrl,
    maxReceiveCount: 5,
    region,
  }, null, 2));
  console.log('\nConfigure SQS_QUEUE_URL with queueUrl before starting the app.');
} finally {
  sqs.destroy();
}
