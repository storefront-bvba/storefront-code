// Storefront Code (fork, see fork/GOAL.md): 16-bit mono PCM to raw Opus packets with the system's
// Opus encoder. Kept free of ExpoModulesCore so a macOS command-line tool can test the same code.
import AVFoundation

final class OpusPacketEncoder {
  enum Failure: Error {
    case unsupportedFormat
    case encoderUnavailable
  }

  static let framesPerPacket: AVAudioFrameCount = 320
  /// libopus' lookahead at 48 kHz, the usual pre-skip when the converter reports no priming.
  static let defaultPreSkip = 312
  private static let outputPackets: AVAudioPacketCount = 32

  let preSkip: Int
  private let converter: AVAudioConverter
  private let pcm: AVAudioFormat
  private let output: AVAudioCompressedBuffer
  private let bytesPerPacket: Int
  /// Input bytes short of one whole packet, kept for the next call.
  private var pending = Data()

  init(sampleRate: Double, bitRate: Int) throws {
    guard
      let pcm = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)
    else { throw Failure.unsupportedFormat }
    var description = AudioStreamBasicDescription(
      mSampleRate: sampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0,
      mBytesPerPacket: 0, mFramesPerPacket: Self.framesPerPacket, mBytesPerFrame: 0,
      mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
    guard
      let opus = AVAudioFormat(streamDescription: &description),
      let converter = AVAudioConverter(from: pcm, to: opus)
    else { throw Failure.encoderUnavailable }
    converter.bitRate = bitRate
    let leading = Int(converter.primeInfo.leadingFrames)
    self.preSkip = leading > 0 ? Int((Double(leading) * 48_000 / sampleRate).rounded()) : Self.defaultPreSkip
    self.converter = converter
    self.pcm = pcm
    self.bytesPerPacket = Int(Self.framesPerPacket) * 2
    self.output = AVAudioCompressedBuffer(
      format: opus, packetCapacity: Self.outputPackets, maximumPacketSize: max(converter.maximumOutputPacketSize, 1_500))
  }

  /// Zero or more packets; input short of a whole packet waits for the next call.
  func encode(_ bytes: Data) throws -> [Data] {
    pending.append(bytes)
    let whole = pending.count - pending.count % bytesPerPacket
    guard whole > 0 else { return [] }
    let chunk = Data(pending.prefix(whole))
    pending = Data(pending.dropFirst(whole))
    // Input beyond what the output buffer holds stays inside the converter until finish(),
    // so it gets half a buffer's worth at a time.
    let step = bytesPerPacket * Int(Self.outputPackets) / 2
    return try stride(from: 0, to: whole, by: step).flatMap { start in
      try convert(chunk.subdata(in: start..<min(whole, start + step)), endOfStream: false)
    }
  }

  /// Pads the last packet with silence and drains the encoder.
  func finish() throws -> [Data] {
    var tail = pending
    pending = Data()
    if !tail.isEmpty { tail.append(Data(count: bytesPerPacket - tail.count)) }
    return try convert(tail, endOfStream: true)
  }

  private func convert(_ bytes: Data, endOfStream: Bool) throws -> [Data] {
    var supplied = bytes.isEmpty
    let frames = AVAudioFrameCount(bytes.count / 2)
    let buffer = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: max(frames, 1))
    if let buffer, frames > 0, let samples = buffer.int16ChannelData {
      let destination = UnsafeMutableRawBufferPointer(start: samples[0], count: Int(frames) * 2)
      bytes.withUnsafeBytes { destination.copyMemory(from: $0) }
      buffer.frameLength = frames
    }
    var packets: [Data] = []
    while true {
      var failure: NSError?
      let status = converter.convert(to: output, error: &failure) { _, inputStatus in
        if !supplied, let buffer {
          supplied = true
          inputStatus.pointee = .haveData
          return buffer
        }
        inputStatus.pointee = endOfStream ? .endOfStream : .noDataNow
        return nil
      }
      if let failure { throw failure }
      packets.append(contentsOf: drainOutput())
      switch status {
      case .haveData: continue
      case .error: throw Failure.encoderUnavailable
      default: return packets
      }
    }
  }

  private func drainOutput() -> [Data] {
    guard output.packetCount > 0, let descriptions = output.packetDescriptions else { return [] }
    let base = output.data
    let packets = (0..<Int(output.packetCount)).map { index in
      let description = descriptions[index]
      return Data(
        bytes: base.advanced(by: Int(description.mStartOffset)), count: Int(description.mDataByteSize))
    }
    output.packetCount = 0
    output.byteLength = 0
    return packets
  }
}
