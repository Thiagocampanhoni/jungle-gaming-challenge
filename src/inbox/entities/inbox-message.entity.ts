import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  transactionId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

/** One durable receipt per logical message and consumer. */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessage {
  @PrimaryKey({ type: 'string', length: 128, fieldName: 'consumer_name' })
  consumerName!: string;

  @PrimaryKey({ type: 'string', length: 128, fieldName: 'message_id' })
  messageId!: string;

  @Property({ type: 'uuid', fieldName: 'transaction_id' })
  transactionId!: string;

  @Property({ type: 'string', length: 64, fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: Date, fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ type: Date, nullable: true, fieldName: 'processed_at' })
  processedAt: Date | null = null;

  protected constructor() {}

  static receive(props: {
    consumerName: string;
    messageId: string;
    transactionId: string;
    payloadHash: string;
  }): InboxMessage {
    if (!props.consumerName || !props.messageId || !props.transactionId ||
        !/^[0-9a-f]{64}$/.test(props.payloadHash)) {
      throw new Error('INVALID_INBOX_MESSAGE');
    }
    const inbox = new InboxMessage();
    inbox.consumerName = props.consumerName;
    inbox.messageId = props.messageId;
    inbox.transactionId = props.transactionId;
    inbox.payloadHash = props.payloadHash;
    inbox.receivedAt = new Date();
    return inbox;
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    const inbox = new InboxMessage();
    Object.assign(inbox, state);
    return inbox;
  }

  isProcessed(): boolean {
    return this.processedAt !== null;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new Error('INBOX_ALREADY_PROCESSED');
    }
    this.processedAt = at;
  }
}
