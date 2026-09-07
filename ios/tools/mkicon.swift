// Flatten a transparent PNG onto the app's #121212 background at a given size.
// App Store icons must have no alpha channel, and the web icons do.
//   swift mkicon.swift <in.png> <out.png> <side>
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 4, let side = Int(args[3]) else {
	FileHandle.standardError.write("usage: mkicon.swift in.png out.png side\n".data(using: .utf8)!)
	exit(2)
}
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

guard let data = try? Data(contentsOf: inURL),
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
	FileHandle.standardError.write("cannot read source image\n".data(using: .utf8)!)
	exit(1)
}

guard let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8,
                          bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
	exit(1)
}
ctx.setFillColor(CGColor(red: 0x12 / 255.0, green: 0x12 / 255.0, blue: 0x12 / 255.0, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))
ctx.interpolationQuality = .high
ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))

guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
	exit(1)
}
CGImageDestinationAddImage(dest, out, nil)
guard CGImageDestinationFinalize(dest) else { exit(1) }
print("wrote \(outURL.path) at \(side)x\(side)")
