import { asNonEmptyString, asStringArray, requireString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import {
  resolvePathOrDownload,
  runSwiftScript,
} from '@server/services/ToolService/handlers/_shared';
import { isToolSupportedOnPlatform } from '@server/services/ToolAvailabilityService';

const tool: ToolHandler = async (input, settings) => {
  if (!isToolSupportedOnPlatform('ocr_image', process.platform)) {
    throw new Error('Image OCR is only available on macOS because it uses Apple Vision.');
  }
  const source = requireString(input, 'source');
  const languages = asStringArray(input.languages);
  const language = asNonEmptyString(input.language);
  const resolved = await resolvePathOrDownload(source, settings, 'snaglet-ocr-image', '.png');

  try {
    const script = `
import Foundation
import Vision
import ImageIO

let path = CommandLine.arguments[1]
let languageArg = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let languageList = languageArg
  .split(separator: ",")
  .map(String.init)
  .filter { !$0.isEmpty }

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  fputs("Unable to load image at \\(path)\\n", stderr)
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if !languageList.isEmpty {
  request.recognitionLanguages = languageList
}

let handler = VNImageRequestHandler(cgImage: image, options: [:])
try handler.perform([request])
let observations = request.results as? [VNRecognizedTextObservation] ?? []
let text = observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n")
print(text)
`;

    const requestedLanguages = [...languages, ...(language ? [language] : [])].join(',');
    const result = await runSwiftScript(script, [resolved.path, requestedLanguages]);
    if (result.timedOut) {
      throw new Error('OCR timed out');
    }
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `swift OCR failed with exit code ${result.code}`);
    }

    return result.stdout.trim() || '(no text found)';
  } finally {
    await resolved.cleanup();
  }
};

export default tool;
