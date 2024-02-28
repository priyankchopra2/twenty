import { Inject, Injectable, Logger } from '@nestjs/common';

import { gmail_v1 } from 'googleapis';

import { FetchMessagesByBatchesService } from 'src/workspace/messaging/services/fetch-messages-by-batches.service';
import { GmailClientProvider } from 'src/workspace/messaging/services/providers/gmail/gmail-client.provider';
import { MessageQueueService } from 'src/integrations/message-queue/services/message-queue.service';
import { MessageQueue } from 'src/integrations/message-queue/message-queue.constants';
import {
  GmailFullSyncJob,
  GmailFullSyncJobData,
} from 'src/workspace/messaging/jobs/gmail-full-sync.job';
import { ConnectedAccountService } from 'src/workspace/messaging/repositories/connected-account/connected-account.service';
import { WorkspaceDataSourceService } from 'src/workspace/workspace-datasource/workspace-datasource.service';
import { MessageChannelService } from 'src/workspace/messaging/repositories/message-channel/message-channel.service';
import { MessageService } from 'src/workspace/messaging/repositories/message/message.service';
import { createQueriesFromMessageIds } from 'src/workspace/messaging/utils/create-queries-from-message-ids.util';
import { SaveMessagesAndCreateContactsService } from 'src/workspace/messaging/services/save-messages-and-create-contacts.service';

@Injectable()
export class GmailPartialSyncService {
  private readonly logger = new Logger(GmailPartialSyncService.name);

  constructor(
    private readonly gmailClientProvider: GmailClientProvider,
    private readonly fetchMessagesByBatchesService: FetchMessagesByBatchesService,
    @Inject(MessageQueue.messagingQueue)
    private readonly messageQueueService: MessageQueueService,
    private readonly workspaceDataSourceService: WorkspaceDataSourceService,
    private readonly connectedAccountService: ConnectedAccountService,
    private readonly messageChannelService: MessageChannelService,
    private readonly messageService: MessageService,
    private readonly saveMessagesAndCreateContactsService: SaveMessagesAndCreateContactsService,
  ) {}

  public async fetchConnectedAccountThreads(
    workspaceId: string,
    connectedAccountId: string,
    maxResults = 500,
  ): Promise<void> {
    const connectedAccount = await this.connectedAccountService.getByIdOrFail(
      connectedAccountId,
      workspaceId,
    );

    const lastSyncHistoryId = connectedAccount.lastSyncHistoryId;

    if (!lastSyncHistoryId) {
      this.logger.log(
        `gmail partial-sync for workspace ${workspaceId} and account ${connectedAccountId}: no lastSyncHistoryId, falling back to full sync.`,
      );

      await this.fallbackToFullSync(workspaceId, connectedAccountId);

      return;
    }

    const accessToken = connectedAccount.accessToken;
    const refreshToken = connectedAccount.refreshToken;

    if (!refreshToken) {
      throw new Error('No refresh token found');
    }

    let startTime = Date.now();

    const { history, historyId, error } = await this.getHistoryFromGmail(
      refreshToken,
      lastSyncHistoryId,
      maxResults,
    );

    let endTime = Date.now();

    this.logger.log(
      `gmail partial-sync for workspace ${workspaceId} and account ${connectedAccountId} getting history in ${
        endTime - startTime
      }ms.`,
    );

    if (error && error.code === 404) {
      this.logger.log(
        `gmail partial-sync for workspace ${workspaceId} and account ${connectedAccountId}: invalid lastSyncHistoryId, falling back to full sync.`,
      );

      await this.connectedAccountService.deleteHistoryId(
        connectedAccountId,
        workspaceId,
      );

      await this.fallbackToFullSync(workspaceId, connectedAccountId);

      return;
    }

    if (!historyId) {
      throw new Error('No history id found');
    }

    if (historyId === lastSyncHistoryId || !history?.length) {
      this.logger.log(
        `gmail partial-sync for workspace ${workspaceId} and account ${connectedAccountId} done with nothing to update.`,
      );

      return;
    }

    const gmailMessageChannel =
      await this.messageChannelService.getFirstByConnectedAccountIdOrFail(
        connectedAccountId,
        workspaceId,
      );

    const gmailMessageChannelId = gmailMessageChannel.id;

    const { messagesAdded, messagesDeleted } =
      await this.getMessageIdsFromHistory(history);

    const messageQueries = createQueriesFromMessageIds(messagesAdded);

    const { messages: messagesToSave, errors } =
      await this.fetchMessagesByBatchesService.fetchAllMessages(
        messageQueries,
        accessToken,
        'gmail partial-sync',
        workspaceId,
        connectedAccountId,
      );

    if (messagesToSave.length !== 0) {
      await this.saveMessagesAndCreateContactsService.saveMessagesAndCreateContacts(
        messagesToSave,
        connectedAccount,
        workspaceId,
        gmailMessageChannelId,
        'gmail partial-sync',
      );
    }

    if (messagesDeleted.length !== 0) {
      startTime = Date.now();

      await this.messageService.deleteMessages(
        messagesDeleted,
        gmailMessageChannelId,
        workspaceId,
      );

      endTime = Date.now();

      this.logger.log(
        `gmail partial-sync for workspace ${workspaceId} and account ${connectedAccountId}: deleting messages in ${
          endTime - startTime
        }ms.`,
      );
    }

    if (errors.length) throw new Error('Error fetching messages');

    startTime = Date.now();

    await this.connectedAccountService.updateLastSyncHistoryId(
      historyId,
      connectedAccount.id,
      workspaceId,
    );

    endTime = Date.now();

    this.logger.log(
      `gmail partial-sync for workspace ${workspaceId} and account ${connectedAccountId} updating lastSyncHistoryId in ${
        endTime - startTime
      }ms.`,
    );

    this.logger.log(
      `gmail partial-sync for workspace ${workspaceId} and account ${connectedAccountId} done.`,
    );
  }

  private async getMessageIdsFromHistory(
    history: gmail_v1.Schema$History[],
  ): Promise<{
    messagesAdded: string[];
    messagesDeleted: string[];
  }> {
    const { messagesAdded, messagesDeleted } = history.reduce(
      (
        acc: {
          messagesAdded: string[];
          messagesDeleted: string[];
        },
        history,
      ) => {
        const messagesAdded = history.messagesAdded?.map(
          (messageAdded) => messageAdded.message?.id || '',
        );

        const messagesDeleted = history.messagesDeleted?.map(
          (messageDeleted) => messageDeleted.message?.id || '',
        );

        if (messagesAdded) acc.messagesAdded.push(...messagesAdded);
        if (messagesDeleted) acc.messagesDeleted.push(...messagesDeleted);

        return acc;
      },
      { messagesAdded: [], messagesDeleted: [] },
    );

    const uniqueMessagesAdded = messagesAdded.filter(
      (messageId) => !messagesDeleted.includes(messageId),
    );

    const uniqueMessagesDeleted = messagesDeleted.filter(
      (messageId) => !messagesAdded.includes(messageId),
    );

    return {
      messagesAdded: uniqueMessagesAdded,
      messagesDeleted: uniqueMessagesDeleted,
    };
  }

  private async getHistoryFromGmail(
    refreshToken: string,
    lastSyncHistoryId: string,
    maxResults: number,
  ): Promise<{
    history: gmail_v1.Schema$History[];
    historyId?: string | null;
    error?: any;
  }> {
    const gmailClient =
      await this.gmailClientProvider.getGmailClient(refreshToken);

    const fullHistory: gmail_v1.Schema$History[] = [];

    try {
      const history = await gmailClient.users.history.list({
        userId: 'me',
        startHistoryId: lastSyncHistoryId,
        historyTypes: ['messageAdded', 'messageDeleted'],
        maxResults,
      });

      let nextPageToken = history?.data?.nextPageToken;

      const historyId = history?.data?.historyId;

      if (history?.data?.history) {
        fullHistory.push(...history.data.history);
      }

      while (nextPageToken) {
        const nextHistory = await gmailClient.users.history.list({
          userId: 'me',
          startHistoryId: lastSyncHistoryId,
          historyTypes: ['messageAdded', 'messageDeleted'],
          maxResults,
          pageToken: nextPageToken,
        });

        nextPageToken = nextHistory?.data?.nextPageToken;

        if (nextHistory?.data?.history) {
          fullHistory.push(...nextHistory.data.history);
        }
      }

      return { history: fullHistory, historyId };
    } catch (error) {
      const errorData = error?.response?.data?.error;

      if (errorData) {
        return { history: [], error: errorData };
      }

      throw error;
    }
  }

  private async fallbackToFullSync(
    workspaceId: string,
    connectedAccountId: string,
  ) {
    await this.messageQueueService.add<GmailFullSyncJobData>(
      GmailFullSyncJob.name,
      { workspaceId, connectedAccountId },
      {
        retryLimit: 2,
      },
    );
  }
}
