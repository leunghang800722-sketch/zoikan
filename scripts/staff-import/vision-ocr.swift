// 本機 OCR（Apple Vision，繁中＋英文）——WP-STAFF-IMPORT（老闆 2026-10-03）。
// 用法：vision-ocr <image-path> [<image-path> ...]
// 每張圖輸出一行 JSON：{"path":..., "lines":[{"t":文字,"c":信心,"x":,"y":,"w":,"h":}]}
// 座標係 Vision 正規化座標（原點左下，0–1）。影像同輸出都留喺本機 data/（gitignored），
// 呢個檔本身冇任何個人資料。
import Foundation
import Vision
import AppKit

func ocr(_ path: String) -> [String: Any] {
    guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ["path": path, "error": "cannot load image", "lines": []]
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hant", "en-US"]
    req.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { return ["path": path, "error": "\(error)", "lines": []] }
    var lines: [[String: Any]] = []
    for obs in (req.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        lines.append(["t": top.string, "c": Double(top.confidence), "x": Double(b.origin.x), "y": Double(b.origin.y), "w": Double(b.size.width), "h": Double(b.size.height)])
    }
    return ["path": path, "lines": lines]
}

for p in CommandLine.arguments.dropFirst() {
    let r = ocr(p)
    if let d = try? JSONSerialization.data(withJSONObject: r, options: []), let s = String(data: d, encoding: .utf8) { print(s) }
}
