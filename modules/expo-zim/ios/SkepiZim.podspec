require 'json'
require 'digest'

# The Expo-free core of expo-zim (Phase 3b-0): libzim 9.7.0 from the pinned CoreKiwix.xcframework through
# an Objective-C++ shim, the registry, HTML -> text (SwiftSoup) and the sealed zim:// viewer. Kept apart
# from ExpoZim so its XCTests build without React Native (test spec "Tests", added by the app's
# config plugin). Autolinked next to ExpoZim.podspec.
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
lock = JSON.parse(File.read(File.join(__dir__, '..', '..', '..', 'native', 'kiwix', 'corekiwix.lock.json')))
frameworks = File.join(__dir__, 'Frameworks')
kiwix = File.join(frameworks, 'CoreKiwix.xcframework')

# Supply chain (like verifyKiwixChecksum on Android): every linked slice must match the lock file.
# native/kiwix/fetch-corekiwix.sh --install-ios downloads, verifies and installs it; nothing is fetched here.
['CoreKiwix.xcframework/Info.plist',
 'CoreKiwix.xcframework/ios-arm64/merged.a',
 'CoreKiwix.xcframework/ios-arm64_x86_64-simulator/merged.a'].each do |rel|
  file = File.join(frameworks, rel)
  raise "SKEPI: #{file} is missing. Run native/kiwix/fetch-corekiwix.sh --install-ios" unless File.file?(file)
  actual = Digest::SHA256.file(file).hexdigest
  expected = lock['files'][rel]
  raise "SKEPI: CoreKiwix #{lock['version']} SHA-256 mismatch for #{rel}: expected #{expected}, got #{actual}" unless actual == expected
end

# One build setting picks the device or simulator slice; the archive is linked by path (its file is
# merged.a, so -l cannot name it) into the app and the test bundle.
slice = {
  'SKEPI_COREKIWIX_SLICE[sdk=iphoneos*]' => 'ios-arm64',
  'SKEPI_COREKIWIX_SLICE[sdk=iphonesimulator*]' => 'ios-arm64_x86_64-simulator',
}
link = slice.merge('OTHER_LDFLAGS' => "$(inherited) \"#{kiwix}/$(SKEPI_COREKIWIX_SLICE)/merged.a\"")

Pod::Spec.new do |s|
  s.name           = 'SkepiZim'
  s.version        = package['version']
  s.summary        = 'libzim 9.7.0 binding and sealed zim:// viewer for SKEPI (no Expo types)'
  s.description    = s.summary
  s.license        = package['license']
  s.author         = 'SKEPI project'
  s.homepage       = 'https://github.com/anywecon/skepi'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/anywecon/skepi.git' }
  s.static_framework = true

  s.dependency 'SwiftSoup', '2.11.3'
  s.frameworks = 'WebKit'
  s.libraries = 'c++'

  s.source_files = 'Core/**/*.{h,mm,swift}'
  s.public_header_files = 'Core/**/*.h'
  s.pod_target_xcconfig = slice.merge(
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => "$(inherited) \"#{kiwix}/$(SKEPI_COREKIWIX_SLICE)/Headers\"",
  )
  s.user_target_xcconfig = link

  s.test_spec 'Tests' do |t|
    # WKWebView needs a running app (the sealing tests load real pages).
    t.requires_app_host = true
    t.source_files = 'Tests/**/*.swift'
    # Catalog/hash checks use the expo-hash core (modules/expo-hash/ios/SkepiHash.podspec).
    t.dependency 'SkepiHash'
    t.pod_target_xcconfig = link
  end
end
