import { nativeImage } from "electron";
import fs from "fs";
import { getBlurHash, isEmpty, isNotEmpty, resultAwaiter } from "@server/helpers/utils";
import { FileSystem } from "@server/fileSystem";
import { Attachment } from "@server/databases/imessage/entity/Attachment";
import { AttachmentDownloadManager, AttachmentDownloadProgress } from "@server/managers/attachmentDownloadManager";
import { Server } from "@server";

function describeAttachment(attachment?: Attachment | null): string {
    if (!attachment) return "attachment=null";
    return [
        `guid=${attachment.guid}`,
        `transferState=${attachment.transferState}`,
        `filePath=${attachment.filePath ?? "null"}`,
        `transferName=${attachment.transferName ?? "null"}`,
        `totalBytes=${attachment.totalBytes ?? "null"}`,
        `originalGuid=${attachment.originalGuid ?? "null"}`
    ].join("; ");
}

function formatTransactionData(data: any): string {
    if (data == null) return "null";
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

export class AttachmentInterface {
    static livePhotoExts = ["png", "jpeg", "jpg", "heic", "tiff"];

    static async getBlurhash({
        filePath,
        width = null,
        height = null,
        componentX = 3,
        componentY = 3,
        quality = "good"
    }: any): Promise<string> {
        const bh = await getBlurHash({
            image: nativeImage.createFromPath(filePath),
            width,
            height,
            quality,
            componentX,
            componentY
        });
        return bh;
    }

    static async upload(path: string, name: string): Promise<string> {
        if (!path || !name) throw new Error("No path/name provided!");
        if (!fs.existsSync(path)) throw new Error("File does not exist!");

        // Copy the attachment to a more permanent storage using the papi method.
        // This is so the attachment gets copied to the iMessage directory.
        return FileSystem.copyAttachment(path, name, "private-api");
    }

    static getLivePhotoPath(attachment: Attachment): string | null {
        // If we don't have a path, return null
        const fPath = attachment?.filePath;
        if (isEmpty(fPath)) return null;

        // Get the existing extension (if any).
        // If it's been converted, it'll have a double-extension.
        let ext = fPath.includes(".heic.jpeg") ? "heic.jpeg" : fPath.split(".").pop() ?? "";

        // If the extension is not an image extension, return null
        if (!AttachmentInterface.livePhotoExts.includes(ext.toLowerCase())) return null;

        // Escape periods in the extension for the regex
        ext = ext.replace(/\./g, "\\.");

        // Get the path to the live photo
        // Replace the extension with .mov, or add it if there is no extension
        const livePath = isNotEmpty(ext) ? fPath.replace(new RegExp(`\\.${ext}$`), ".mov") : `${fPath}.mov`;
        const realPath = FileSystem.getRealPath(livePath);

        // If the live photo doesn't exist, return null
        if (!fs.existsSync(realPath)) return null;

        // If the .mov file exists, return the path
        return realPath;
    }

    static async getDownloadProgress(
        guid: string,
        attachment?: Attachment | null
    ): Promise<AttachmentDownloadProgress> {
        return AttachmentDownloadManager.get(guid, attachment);
    }

    static async startForceDownload(attachment: Attachment): Promise<AttachmentDownloadProgress> {
        const attachmentGuid = attachment.guid;
        const currentPath = attachment.filePath ? FileSystem.getRealPath(attachment.filePath) : "";
        if (attachment.transferState === 5 && isNotEmpty(currentPath) && fs.existsSync(currentPath)) {
            return AttachmentDownloadManager.markCompletedFromAttachment(attachment);
        }

        const existingProgress = await AttachmentDownloadManager.get(attachmentGuid, attachment);
        if (["requested", "downloading"].includes(existingProgress.state)) {
            Server().log(
                `Attachment force-download already in progress (guid=${attachmentGuid}; state=${existingProgress.state}; requestId=${
                    existingProgress.requestId ?? "null"
                })`,
                "debug"
            );
            return existingProgress;
        }

        Server().log(`Starting attachment force-download (${describeAttachment(attachment)})`, "debug");

        try {
            const result = await Server().privateApi.attachment.downloadPurged(attachmentGuid);
            const progress = AttachmentDownloadManager.upsert({
                guid: attachmentGuid,
                ...AttachmentDownloadManager.fromAttachment(attachment),
                state: "requested",
                stage: "requested",
                requestId: result.data?.requestId ?? existingProgress.requestId ?? null,
                helperMode: result.data?.mode ?? existingProgress.helperMode ?? null
            });

            Server().log(
                `Private API force-download request finished (guid=${attachmentGuid}; identifier=${
                    result.identifier
                }; data=${formatTransactionData(result.data)}; progress=${formatTransactionData(progress)})`,
                "debug"
            );

            return progress;
        } catch (ex) {
            const error = ex instanceof Error ? ex.message : String(ex);
            if (error.includes("No need to unpurge")) {
                return AttachmentDownloadManager.get(attachmentGuid, await Server().iMessageRepo.getAttachment(attachmentGuid));
            }

            AttachmentDownloadManager.markFailed(attachmentGuid, error, {
                ...AttachmentDownloadManager.fromAttachment(attachment)
            });
            throw ex;
        }
    }

    static async forceDownload(attachment: Attachment): Promise<Attachment> {
        const attachmentGuid = attachment.guid;
        const progress = await AttachmentInterface.startForceDownload(attachment);
        Server().log(
            `Awaiting attachment force-download completion (guid=${attachmentGuid}; state=${progress.state}; requestId=${
                progress.requestId ?? "null"
            })`,
            "debug"
        );

        attachment = await resultAwaiter({
            maxWaitMs: 1000 * 60 * 10,
            initialWaitMs: 1000,
            waitMultiplier: 1,
            getData: async (_: any) => {
                const latest = await Server().iMessageRepo.getAttachment(attachmentGuid);
                await AttachmentDownloadManager.get(attachmentGuid, latest);
                return latest;
            },
            dataLoopCondition: (data: Attachment) => {
                return !data || data.transferState !== 5;
            }
        });

        if (!attachment || attachment.transferState !== 5) {
            const error = `Failed to download attachment! Transfer State: ${attachment?.transferState}`;
            AttachmentDownloadManager.markFailed(attachmentGuid, error, {
                ...AttachmentDownloadManager.fromAttachment(attachment)
            });
            Server().log(
                `Attachment force-download timed out or ended in a non-downloaded state (${describeAttachment(
                    attachment
                )})`,
                "warn"
            );
            throw new Error(error);
        }

        AttachmentDownloadManager.markCompletedFromAttachment(attachment);
        Server().log(`Attachment force-download completed (${describeAttachment(attachment)})`, "debug");
        return attachment;
    }
}
