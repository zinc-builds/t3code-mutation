import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type EnvironmentId,
  type UploadChatAttachment,
} from "@t3tools/contracts";

import type { ComposerFileAttachment } from "~/composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import { readFileAsDataUrl } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";

import { fileAttachmentCapabilityBlockReason } from "../chat/composerAttachmentFiles";

export interface WorkspaceMessageAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  /**
   * Lets go of the uploads once the turn has started (the turn holds its own
   * copies) or failed. Call it either way.
   */
  readonly release: () => void;
}

const attachmentName = (file: File) => file.name.trim().slice(0, 255) || "export";

const sendsInline = (file: File) =>
  isProviderSendTurnSupportedImageMimeType(file.type) &&
  file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

/**
 * The attachments for files a workspace page sends with a message, made the
 * way the composer makes them: images the provider takes travel inline, and
 * every other file goes through the composer's upload queue, so it needs a
 * server that accepts uploads. Rejects with the reason when any file cannot go.
 */
export async function prepareWorkspaceMessageAttachments(
  environmentId: EnvironmentId,
  files: ReadonlyArray<File>,
): Promise<WorkspaceMessageAttachments> {
  const uploads = new Map<File, ComposerFileAttachment>(
    files
      .filter((file) => !sendsInline(file))
      .map((file) => [
        file,
        {
          type: "file",
          id: randomUUID(),
          name: attachmentName(file),
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          file,
        },
      ]),
  );
  const pending = [...uploads.values()];
  const release = () => {
    for (const upload of pending) releaseAttachmentUpload(upload.id);
  };
  if (pending.length > 0) {
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
    const blockReason = fileAttachmentCapabilityBlockReason({
      files: pending,
      attachmentUploadsCapabilityKnown: config !== null,
      supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
      maxFileAttachmentBytes:
        config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
    });
    if (blockReason !== null) throw new Error(blockReason);
    for (const upload of pending) startAttachmentUpload({ environmentId, image: upload });
    await awaitAttachmentUploads(pending.map((upload) => upload.id));
  }
  const uploaded = getUploadedAttachments({ environmentId, images: pending });
  if (uploaded === null) {
    const failure = pending
      .map((upload) => readAttachmentUpload(upload.id))
      .find((state) => state?.status === "failed");
    release();
    throw new Error(
      `The workspace's files could not be uploaded${failure?.status === "failed" ? `: ${failure.reason}` : "."}`,
    );
  }
  const uploadedByFile = new Map(pending.map((upload, index) => [upload.file, uploaded[index]!]));
  try {
    const attachments = await Promise.all(
      files.map(
        async (file): Promise<ChatAttachment | UploadChatAttachment> =>
          uploadedByFile.get(file) ?? {
            type: "image",
            name: attachmentName(file),
            mimeType: file.type,
            sizeBytes: file.size,
            dataUrl: await readFileAsDataUrl(file),
          },
      ),
    );
    return { attachments, release };
  } catch (error) {
    release();
    throw error;
  }
}
