Pod::Spec.new do |s|
  s.name = 'StorefrontOpus'
  s.version = '1.0.0'
  s.summary = 'Opus packets for Storefront Code dictation.'
  s.description = 'Encodes 16 kHz mono PCM to raw Opus packets with the AudioToolbox Opus encoder (AVAudioConverter).'
  s.author = 'Storefront'
  s.homepage = 'https://github.com/storefront-bvba/storefront-code'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'AudioToolbox'
end
