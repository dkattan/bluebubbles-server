import fs from "fs";

import { Server } from "@server";
import { Attachment } from "@server/databases/imessage/entity/Attachment";
import { FileSystem } from "@server/fileSystem";
import { isNotEmpty } from "@server/helpers/utils";

export type AttachmentDownloadState = "idle" | "requested" | "downloading" | "completed" | "failed";

export type AttachmentDownloadProgress = {
    guid: string;
    messageGuid?: string | null;
    requestId?: string | null;
    helperMode?: string | null;
    state: AttachmentDownloadState;
    stage?: string | null;
    error?: string | null;
    currentBytes?: number | null;
    totalBytes?: number | null;
    averageTransferRate?: number | null;
    transferState?: number | null;
    filePath?: string | null;
    transferName?: string | null;
    mimeType?: string | null;
    progress?: number | null;
    updatedAt: number;
    startedAt?: number | null;
    completedAt?: number | null;
};

type AttachmentDownloadProgressUpdate = Partial<AttachmentDownloadProgress> & {
    guid: string;
};

export class AttachmentDownloadManager {
    static cache: Record<string, AttachmentDownloadProgress> = {};

    static hasReadableFile(filePath?: string | null): boolean {
        if (!isNotEmpty(filePath ?? "")) return false;

        try {
            return fs.existsSync(FileSystem.getRealPath(filePath as string));
        } catch {
            return false;
        }
    }

    static fromAttachment(attachment?: Attachment | null): Partial<AttachmentDownloadProgress> {
        if (!attachment) return {};

        return {
            transferState: attachment.transferState ?? null,
            filePath: attachment.filePath ?? null,
            transferName: attachment.transferName ?? null,
            mimeType: attachment.mimeType ?? null,
            totalBytes: attachment.totalBytes ?? null
        };
    }

    static inferState(
        existing: AttachmentDownloadProgress | undefined,
        update: AttachmentDownloadProgressUpdate
    ): AttachmentDownloadState {
        const fileReadable = this.hasReadableFile(update.filePath ?? existing?.filePath ?? null);
        const transferState = update.transferState ?? existing?.transferState ?? null;
        const currentBytes = update.currentBytes ?? existing?.currentBytes ?? null;
        const totalBytes = update.totalBytes ?? existing?.totalBytes ?? null;
        const stage = update.stage ?? existing?.stage ?? null;

        if (update.error) return "failed";
        if (update.state) return update.state;
        if (stage === "failed") return "failed";
        if (stage === "completed" || transferState === 5 || fileReadable) return "completed";
        if (stage === "requested" || stage === "started") {
            return existing?.state === "downloading" ? "downloading" : "requested";
        }
        if (stage === "progress" || stage === "state-changed") return "downloading";
        if (currentBytes != null && currentBytes > 0) return "downloading";
        if (totalBytes != null && totalBytes > 0 && transferState != null && transferState > 0) return "downloading";
        if (existing?.state) return existing.state;
        return "idle";
    }

    static upsert(update: AttachmentDownloadProgressUpdate): AttachmentDownloadProgress {
        const now = Date.now();
        const existing = this.cache[update.guid];
        const state = this.inferState(existing, update);
        const totalBytes = update.totalBytes ?? existing?.totalBytes ?? null;
        let currentBytes = update.currentBytes ?? existing?.currentBytes ?? null;

        if (state === "completed" && totalBytes != null && totalBytes > 0) {
            currentBytes = totalBytes;
        }

        const progress =
            totalBytes != null && totalBytes > 0 && currentBytes != null
                ? Math.max(0, Math.min(1, currentBytes / totalBytes))
                : existing?.progress ?? null;
        const error = state === "failed" ? update.error ?? existing?.error ?? null : update.error ?? null;
        const shouldResetStartedAt =
            existing != null && existing.state !== state && ["requested", "downloading"].includes(state);

        const next: AttachmentDownloadProgress = {
            guid: update.guid,
            messageGuid: update.messageGuid ?? existing?.messageGuid ?? null,
            requestId: update.requestId ?? existing?.requestId ?? null,
            helperMode: update.helperMode ?? existing?.helperMode ?? null,
            state,
            stage: update.stage ?? existing?.stage ?? null,
            error,
            currentBytes,
            totalBytes,
            averageTransferRate: update.averageTransferRate ?? existing?.averageTransferRate ?? null,
            transferState: update.transferState ?? existing?.transferState ?? null,
            filePath: update.filePath ?? existing?.filePath ?? null,
            transferName: update.transferName ?? existing?.transferName ?? null,
            mimeType: update.mimeType ?? existing?.mimeType ?? null,
            progress,
            updatedAt: now,
            startedAt: shouldResetStartedAt ? now : existing?.startedAt ?? (state === "idle" ? null : now),
            completedAt: state === "completed" ? existing?.completedAt ?? now : null
        };

        this.cache[update.guid] = next;
        return next;
    }

    static markFailed(
        guid: string,
        error: string,
        update: Partial<AttachmentDownloadProgress> = {}
    ): AttachmentDownloadProgress {
        return this.upsert({
            guid,
            ...update,
            state: "failed",
            stage: "failed",
            error
        });
    }

    static markCompletedFromAttachment(attachment: Attachment): AttachmentDownloadProgress {
        return this.upsert({
            guid: attachment.guid,
            ...this.fromAttachment(attachment),
            state: "completed",
            stage: "completed",
            currentBytes: attachment.totalBytes ?? null
        });
    }

    static async get(guid: string, attachment?: Attachment | null): Promise<AttachmentDownloadProgress> {
        let currentAttachment = attachment;
        if (currentAttachment === undefined) {
            currentAttachment = await Server().iMessageRepo.getAttachment(guid);
        }

        if (currentAttachment && currentAttachment.transferState === 5 && this.hasReadableFile(currentAttachment.filePath)) {
            return this.markCompletedFromAttachment(currentAttachment);
        }

        if (currentAttachment) {
            return this.upsert({
                guid,
                ...this.fromAttachment(currentAttachment)
            });
        }

        const existing = this.cache[guid];
        if (existing) return existing;
        return this.upsert({ guid });
    }
}
