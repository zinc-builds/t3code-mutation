import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";

import { shareGeneratedAttachment } from "../../../lib/attachmentDownload";
import { estimateBase64ByteSize } from "../../../lib/base64";
import { COMPOSER_ATTACHMENT_DIRECTORY } from "../../../lib/composerAttachmentFiles";
import type { DraftComposerAttachment } from "../../../lib/composerImages";
import { uuidv4 } from "../../../lib/uuid";
import type { WorkspaceEncodedFile } from "./workspaceWebViewBridge";

const safeFileName = (name: string) =>
  Array.from(name, (character) =>
    character === "/" || character === "\\" || character.charCodeAt(0) < 32 ? "-" : character,
  ).join("") || "export";

/**
 * Composer attachments for files a workspace page sent, made the way the
 * composer makes them: pictures the provider takes travel inline, and every
 * other file is written to the composer's attachment directory, from which
 * the send uploads it.
 */
export async function workspaceDraftAttachments(
  files: ReadonlyArray<WorkspaceEncodedFile>,
): Promise<DraftComposerAttachment[]> {
  return Promise.all(
    files.map(async (file): Promise<DraftComposerAttachment> => {
      const sizeBytes = estimateBase64ByteSize(file.base64);
      const pictureType = imageMimeType({ name: file.name, mimeType: file.mimeType });
      if (
        pictureType !== null &&
        isProviderSendTurnSupportedImageMimeType(pictureType) &&
        sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ) {
        const dataUrl = `data:${pictureType};base64,${file.base64}`;
        return {
          id: uuidv4(),
          type: "image",
          name: file.name,
          mimeType: pictureType,
          sizeBytes,
          previewUri: dataUrl,
          dataUrl,
        };
      }
      const { Directory, File, Paths } = await import("expo-file-system");
      const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
      directory.create({ idempotent: true, intermediates: true });
      const target = new File(directory, `${uuidv4()}-${safeFileName(file.name)}`);
      await target.write(file.base64, { encoding: "base64" });
      return {
        id: uuidv4(),
        type: "file",
        name: file.name,
        mimeType: file.mimeType || "application/octet-stream",
        sizeBytes,
        fileUri: target.uri,
      };
    }),
  );
}

/** Hands a file the page made to the share sheet, where the user saves or sends it on. */
export async function shareWorkspaceFile(file: WorkspaceEncodedFile): Promise<void> {
  const shared = await shareGeneratedAttachment({
    bytes: Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0)),
    attachment: { name: file.name, mimeType: file.mimeType || "application/octet-stream" },
    signal: new AbortController().signal,
  });
  if (!shared) throw new Error("Saving files is not available on this device.");
}
