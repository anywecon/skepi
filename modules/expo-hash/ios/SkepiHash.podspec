require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The Expo-free core of expo-hash (Phase 3b-0): streaming SHA-256 of whole files and catalog chunks
# (CryptoKit). Also used by the SkepiZim XCTests to check fixtures against the signed test catalog.
Pod::Spec.new do |s|
  s.name           = 'SkepiHash'
  s.version        = package['version']
  s.summary        = 'Streaming SHA-256 (whole file + chunks) for SKEPI (no Expo types)'
  s.description    = s.summary
  s.license        = package['license']
  s.author         = 'SKEPI project'
  s.homepage       = 'https://github.com/anywecon/skepi'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/anywecon/skepi.git' }
  s.static_framework = true

  s.source_files = 'Core/**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
