import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';

/**
 * Photographing a document into the register.
 *
 * THE RULE THAT DECIDES EVERYTHING HERE:
 *
 *   A file the register is GIVEN goes in byte for byte. A photograph the officer TAKES is
 *   authored at a resolution the officer chose.
 *
 * The requirement is that documents are stored verbatim, and the test in
 * documents.service.test.ts puts it exactly: "what the complainant SENT is what the
 * register holds, byte for byte". That is a rule about not altering what you were handed.
 * It is not a rule that a camera must run at its maximum sensor resolution - a flatbed
 * scanner set to 200 dpi is not compressing evidence either, and nobody has ever argued it
 * was. When the officer points a phone at a bill, the register is the author of that image,
 * and choosing 200 dpi rather than 600 is the same decision as choosing a scanner setting.
 *
 * So: pickFile() never touches a byte. photograph() resizes, and says so.
 *
 * WHAT IT MUST NEVER DO, and does not:
 *   - resize, re-encode or "enhance" anything picked from the device's files
 *   - re-compress an image a second time
 *   - strip or alter anything after the sha256 has been taken
 *
 * The hash is computed by the register on commit, from the bytes it receives. Whatever is
 * uploaded is what is hashed, so there is no window in which the stored bytes and the
 * recorded hash can disagree.
 */

export type CaptureKind = 'document' | 'clinical';

/**
 * Two settings, because two kinds of thing get photographed and they are not alike.
 *
 * `document` - a bill, a prescription, a letter, a postal acknowledgement card. What
 * matters is that the text is legible. 2200px on the long edge is about 260 dpi across A4,
 * comfortably above the ~200 dpi where scanned text stops being reliably readable and
 * below the point where the file gets large for nothing. A typical page lands around
 * 400-700 KB instead of four megabytes.
 *
 * `clinical` - a radiograph on a viewer, an intraoral photograph. Detail IS the content
 * here: this is the document an expert opinion turns on, and a compression artefact at the
 * apex of a root is not a cosmetic loss. No downscale, and quality high enough that the
 * re-encode is visually lossless. It will be a few megabytes and that is correct.
 *
 * The officer chooses, at the moment of capture, looking at the thing. No heuristic can do
 * this: document_class has no radiograph value, and a radiograph is filed as
 * complaint_material like everything else the complainant sends.
 */
const SETTINGS: Record<CaptureKind, { maxEdge: number | null; quality: number; why: string }> = {
  document: {
    maxEdge: 2200,
    quality: 0.72,
    why: 'Photographed at about 260 dpi across A4 - legible text, a few hundred kilobytes.',
  },
  clinical: {
    maxEdge: null,
    quality: 0.92,
    why: 'Photographed at full resolution. Detail is the content in a radiograph.',
  },
};

export interface CapturedFile {
  uri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** True when the register received the bytes untouched. */
  verbatim: boolean;
  /** Shown to the officer, and worth recording: how this file came to exist. */
  provenance: string;
}

/** SDK 57 replaced getInfoAsync with a File object whose `size` is a plain property. */
function sizeOf(uri: string): number {
  try {
    return new FileSystem.File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Take a photograph of a document.
 *
 * Returns null when the officer backs out, which is not an error and must not be reported
 * as one.
 */
export async function photograph(kind: CaptureKind): Promise<CapturedFile | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('The camera is not available. Allow camera access in Settings.');
  }

  const shot = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    // Never the system cropper: a cropped bill is an altered document, and the officer
    // should not be able to remove part of one by accident on a small screen.
    allowsEditing: false,
    // Ask the camera for everything; the resize below is the single, deliberate step.
    quality: 1,
    exif: false,
  });
  if (shot.canceled || !shot.assets[0]) return null;

  const asset = shot.assets[0];
  const { maxEdge, quality, why } = SETTINGS[kind];

  // One manipulation, once. Re-encoding an already-compressed JPEG a second time is how
  // images quietly rot, so this runs on the camera's output and nothing else afterwards.
  const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
  if (maxEdge && Math.max(asset.width, asset.height) > maxEdge) {
    context.resize(asset.width >= asset.height ? { width: maxEdge } : { height: maxEdge });
  }
  const rendered = await context.renderAsync();
  const out = await rendered.saveAsync({
    compress: quality,
    format: ImageManipulator.SaveFormat.JPEG,
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return {
    uri: out.uri,
    filename: `photograph-${stamp}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: sizeOf(out.uri),
    verbatim: false,
    provenance: `Photographed by the officer. ${why}`,
  };
}

/**
 * Choose a file already on the device.
 *
 * NOTHING is done to it. Someone emailed the officer a radiograph, or a complainant handed
 * over a PDF - the register was GIVEN that file, and the rule about verbatim applies with
 * full force. It goes up exactly as it is.
 */
export async function pickFile(): Promise<CapturedFile | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Photo access is not available. Allow it in Settings.');
  }

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    // quality is ignored when nothing is edited, and nothing is edited. Stated so that a
    // future reader does not "helpfully" add a compression step here.
    quality: 1,
    exif: false,
  });
  if (picked.canceled || !picked.assets[0]) return null;

  const asset = picked.assets[0];
  return {
    uri: asset.uri,
    filename: asset.fileName ?? `file-${Date.now()}.jpg`,
    contentType: asset.mimeType ?? 'image/jpeg',
    sizeBytes: asset.fileSize ?? sizeOf(asset.uri),
    verbatim: true,
    provenance: 'Taken from the device, unaltered - stored exactly as it was received.',
  };
}

export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
