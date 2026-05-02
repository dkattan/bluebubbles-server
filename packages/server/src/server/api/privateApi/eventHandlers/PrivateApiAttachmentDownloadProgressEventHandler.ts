import { Server } from "@server";
import { AttachmentDownloadManager } from "@server/managers/attachmentDownloadManager";
import { Loggable } from "@server/lib/logging/Loggable";
import { PrivateApiEventHandler, EventData } from ".";

export class PrivateApiAttachmentDownloadProgressEventHandler extends Loggable implements PrivateApiEventHandler {
    tag = "PrivateApiAttachmentDownloadProgressEventHandler";

    types: string[] = ["attachment-download-progress"];

    async handle(event: EventData) {
        const guid = (event.attachmentGuid as string) ?? event.guid;
        if (!guid) {
            this.log.warn("Received attachment-download-progress event without an attachment GUID");
            return;
        }

        const progress = AttachmentDownloadManager.upsert({
            guid,
            messageGuid: (event.messageGuid as string) ?? null,
            requestId: (event.requestId as string) ?? null,
            helperMode: (event.mode as string) ?? null,
            stage: (event.stage as string) ?? null,
            error: (event.error as string) ?? null,
            currentBytes: typeof event.currentBytes === "number" ? event.currentBytes : null,
            totalBytes: typeof event.totalBytes === "number" ? event.totalBytes : null,
            averageTransferRate: typeof event.averageTransferRate === "number" ? event.averageTransferRate : null,
            transferState: typeof event.transferState === "number" ? event.transferState : null,
            filePath: (event.localPath as string) ?? (event.filename as string) ?? null,
            transferName: (event.transferName as string) ?? (event.filename as string) ?? null,
            mimeType: (event.mimeType as string) ?? null
        });

        this.log.debug(
            `Tracked attachment download progress (guid=${guid}; state=${progress.state}; stage=${progress.stage ?? "null"}; currentBytes=${
                progress.currentBytes ?? "null"
            }; totalBytes=${progress.totalBytes ?? "null"})`
        );

        Server().emit("attachment-download-progress", progress);
    }
}
