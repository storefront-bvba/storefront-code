// Storefront Code (fork, see fork/GOAL.md): Opus packets for dictation, see
// fork/design/F2-opus-voice.md. The Ogg container is written in TypeScript (src/storefront/voice/ogg.ts).
import ExpoModulesCore
import Foundation

public class StorefrontOpusModule: Module {
  // Sync functions run on the JavaScript thread, so the table needs no lock.
  private var encoders: [Int: OpusPacketEncoder] = [:]
  private var nextId = 1

  public func definition() -> ModuleDefinition {
    Name("StorefrontOpus")

    Function("createEncoder") { (sampleRate: Int, bitRate: Int) throws -> Int in
      let encoder = try OpusPacketEncoder(sampleRate: Double(sampleRate), bitRate: bitRate)
      let id = nextId
      nextId += 1
      encoders[id] = encoder
      return id
    }

    Function("encode") { (id: Int, pcm: Data) throws -> [Data] in
      try encoder(id).encode(pcm)
    }

    Function("finish") { (id: Int) throws -> [Data] in
      try encoder(id).finish()
    }

    Function("preSkip") { (id: Int) throws -> Int in
      try encoder(id).preSkip
    }

    Function("release") { (id: Int) in
      encoders[id] = nil
    }

    OnDestroy {
      encoders.removeAll()
    }
  }

  private func encoder(_ id: Int) throws -> OpusPacketEncoder {
    guard let encoder = encoders[id] else { throw Exception(name: "UnknownEncoder", description: "No Opus encoder \(id)") }
    return encoder
  }
}
