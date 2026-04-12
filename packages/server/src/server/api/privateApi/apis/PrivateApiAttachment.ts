import { Server } from "@server";
import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";

function formatTransactionData(data: any): string {
    if (data == null) return "null";
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

export class PrivateApiAttachment extends PrivateApiAction {
    tag = "PrivateApiAttachment";

    async send({
        chatGuid,
        filePath,
        isAudioMessage = false,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0
    }: {
        chatGuid: string;
        filePath: string;
        isAudioMessage?: boolean;
        attributedBody?: Record<string, any> | null;
        subject?: string;
        effectId?: string;
        selectedMessageGuid?: string;
        partIndex?: number;
    }): Promise<TransactionResult> {
        const action = "send-attachment";
        this.throwForNoMissingFields(action, [chatGuid, filePath]);
        const request = new TransactionPromise(TransactionType.ATTACHMENT);
        return this.sendApiMessage(
            action,
            {
                chatGuid,
                filePath,
                isAudioMessage: isAudioMessage ? 1 : 0,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex
            },
            request
        );
    }

    async downloadPurged(guid: string): Promise<TransactionResult> {
        const action = "download-purged-attachment";
        this.throwForNoMissingFields(action, [guid]);

        const request = new TransactionPromise(TransactionType.ATTACHMENT);
        Server().log(
            `Requesting purged attachment download via Private API (GUID: ${guid}; transactionId: ${request.transactionId})`,
            "debug"
        );

        try {
            const result = await this.sendApiMessage(action, { attachmentGuid: guid }, request);
            Server().log(
                `Private API purged attachment download completed (GUID: ${guid}; transactionId: ${
                    request.transactionId
                }; identifier: ${result.identifier}; data: ${formatTransactionData(result.data)})`,
                "debug"
            );
            return result;
        } catch (ex) {
            Server().log(
                `Private API purged attachment download failed (GUID: ${guid}; transactionId: ${
                    request.transactionId
                }): ${String(ex)}`,
                "warn"
            );
            throw ex;
        }
    }
}
