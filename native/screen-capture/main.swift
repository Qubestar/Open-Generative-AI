// vidmyo-capture — native macOS screen recorder built on ScreenCaptureKit.
//
// Replaces the ffmpeg/avfoundation screen input, which produces no frames on
// macOS 15+. ScreenCaptureKit also captures system audio directly, so no
// virtual loopback driver (BlackHole) is needed.
//
// Usage:
//   vidmyo-capture list
//     -> prints one JSON object: { displays: [...], microphones: [...] }
//   vidmyo-capture record --display <id> --out <file.mp4> [--fps 30]
//                         [--system-audio] [--mic <deviceUID|default>]
//     -> prints JSON lines on stdout: {"event":"started",...} then
//        {"event":"stopped",...} or {"event":"error","message":...}.
//        SIGINT / SIGTERM (or "q" on stdin) finalizes the file and exits 0.
//
// Exit codes: 0 ok, 2 bad arguments, 3 screen permission denied,
// 4 capture failure, 5 microphone permission denied.
//
// The microphone is written to <out>.mic.m4a (SCRecordingOutput omits it);
// the "stopped" event reports micPath and micOffsetMs for the caller to mix.

import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
     let line = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  }
}

func fail(_ message: String, code: Int32) -> Never {
  emit(["event": "error", "message": message, "code": Int(code)])
  emergencyStopCapture()
  exit(code)
}

func isPermissionError(_ error: Error) -> Bool {
  let ns = error as NSError
  // SCStreamErrorUserDeclined = -3801
  return ns.domain == SCStreamErrorDomain && ns.code == -3801
}

func microphones() -> [AVCaptureDevice] {
  AVCaptureDevice.DiscoverySession(
    deviceTypes: [.microphone, .external],
    mediaType: .audio,
    position: .unspecified
  ).devices
}

// MARK: - list

func runList() async {
  var displays: [[String: Any]] = []
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let mainID = CGMainDisplayID()
    for (i, d) in content.displays.enumerated() {
      displays.append([
        "id": Int(d.displayID),
        "name": d.displayID == mainID ? "Ekran główny" : "Ekran \(i + 1)",
        "width": d.width,
        "height": d.height,
        "isMain": d.displayID == mainID,
      ])
    }
  } catch {
    if isPermissionError(error) { fail("Screen Recording permission denied", code: 3) }
    fail("Could not list displays: \(error.localizedDescription)", code: 4)
  }
  let defaultMic = AVCaptureDevice.default(for: .audio)?.uniqueID
  let mics: [[String: Any]] = microphones().map {
    ["id": $0.uniqueID, "name": $0.localizedName, "isDefault": $0.uniqueID == defaultMic]
  }
  emit(["displays": displays, "microphones": mics])
  exit(0)
}

// MARK: - record

final class Recorder: NSObject, SCStreamDelegate, SCRecordingOutputDelegate, AVCaptureFileOutputRecordingDelegate {
  var stream: SCStream?
  var recording: SCRecordingOutput?
  let outURL: URL
  var startedAt = Date()
  var stopping = false

  // SCRecordingOutput does not write the microphone, so it is recorded to a
  // sidecar .m4a and mixed in by the caller using the reported offset.
  var micSession: AVCaptureSession?
  var micOutput: AVCaptureAudioFileOutput?
  var micURL: URL?
  var videoStartedAtMs: Double?
  var micStartedAtMs: Double?
  var videoDone = false
  var micDone = true

  init(outURL: URL) { self.outURL = outURL }

  static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

  func startMicrophone(_ mic: String) {
    let device = mic == "default"
      ? AVCaptureDevice.default(for: .audio)
      : AVCaptureDevice(uniqueID: mic)
    guard let device = device else { fail("Microphone \(mic) not found", code: 2) }
    let session = AVCaptureSession()
    do {
      let input = try AVCaptureDeviceInput(device: device)
      guard session.canAddInput(input) else { fail("Cannot use microphone \(device.localizedName)", code: 4) }
      session.addInput(input)
    } catch {
      fail("Microphone unavailable: \(error.localizedDescription)", code: 4)
    }
    let output = AVCaptureAudioFileOutput()
    guard session.canAddOutput(output) else { fail("Cannot record microphone", code: 4) }
    session.addOutput(output)
    session.startRunning()
    let url = outURL.deletingPathExtension().appendingPathExtension("mic.m4a")
    try? FileManager.default.removeItem(at: url)
    micDone = false
    output.startRecording(to: url, outputFileType: .m4a, recordingDelegate: self)
    micSession = session
    micOutput = output
    micURL = url
  }

  func start(displayID: UInt32, fps: Int, systemAudio: Bool, mic: String?) async {
    let content: SCShareableContent
    do {
      content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
      if isPermissionError(error) { fail("Screen Recording permission denied", code: 3) }
      fail("Could not read shareable content: \(error.localizedDescription)", code: 4)
    }
    guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? (displayID == 0 ? content.displays.first : nil) else {
      fail("Display \(displayID) not found", code: 2)
    }

    if let mic = mic {
      let granted = await AVCaptureDevice.requestAccess(for: .audio)
      if !granted { fail("Microphone permission denied", code: 5) }
      startMicrophone(mic)
    }

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    // Record at native pixel resolution.
    let scale = Int(filter.pointPixelScale.rounded())
    cfg.width = display.width * max(scale, 1)
    cfg.height = display.height * max(scale, 1)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, min(fps, 60))))
    cfg.showsCursor = true
    cfg.queueDepth = 6
    cfg.capturesAudio = systemAudio
    cfg.excludesCurrentProcessAudio = true
    cfg.sampleRate = 48000
    cfg.channelCount = 2

    let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
    let recCfg = SCRecordingOutputConfiguration()
    recCfg.outputURL = outURL
    recCfg.outputFileType = .mp4
    recCfg.videoCodecType = .h264
    let recording = SCRecordingOutput(configuration: recCfg, delegate: self)
    do {
      try stream.addRecordingOutput(recording)
      try await stream.startCapture()
    } catch {
      if isPermissionError(error) { fail("Screen Recording permission denied", code: 3) }
      fail("Could not start capture: \(error.localizedDescription)", code: 4)
    }
    self.stream = stream
    self.recording = recording
    startedAt = Date()
    emit([
      "event": "started",
      "displayId": Int(displayID),
      "width": cfg.width,
      "height": cfg.height,
      "systemAudio": systemAudio,
      "microphone": mic ?? NSNull(),
      "startedAtMs": Int(startedAt.timeIntervalSince1970 * 1000),
    ])
  }

  func stop() async {
    guard let stream = stream, !stopping else { return }
    stopping = true
    micOutput?.stopRecording()
    do { try await stream.stopCapture() } catch { /* already stopped */ }
    // The finish delegates exit the process; guard against one never firing.
    try? await Task.sleep(nanoseconds: 10_000_000_000)
    fail("Recording did not finalize in time", code: 4)
  }

  func finishIfDone() {
    guard videoDone && micDone else { return }
    micSession?.stopRunning()
    var payload: [String: Any] = [
      "event": "stopped",
      "outputPath": outURL.path,
      "durationSec": Date().timeIntervalSince(startedAt),
    ]
    if let micURL = micURL, FileManager.default.fileExists(atPath: micURL.path) {
      payload["micPath"] = micURL.path
      // Positive = mic started after the first video frame.
      if let v = videoStartedAtMs, let m = micStartedAtMs { payload["micOffsetMs"] = m - v }
    }
    emit(payload)
    exit(0)
  }

  // SCStreamDelegate
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    if isPermissionError(error) { fail("Screen Recording permission denied", code: 3) }
    fail("Capture stopped: \(error.localizedDescription)", code: 4)
  }

  // SCRecordingOutputDelegate
  func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
    videoStartedAtMs = Recorder.nowMs()
  }

  func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
    fail("Recording failed: \(error.localizedDescription)", code: 4)
  }

  func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
    DispatchQueue.main.async {
      self.videoDone = true
      self.finishIfDone()
    }
  }

  // AVCaptureFileOutputRecordingDelegate (microphone sidecar)
  func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
    micStartedAtMs = Recorder.nowMs()
  }

  func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
    DispatchQueue.main.async {
      self.micDone = true
      if !self.stopping, let error = error {
        fail("Microphone recording failed: \(error.localizedDescription)", code: 4)
      }
      self.finishIfDone()
    }
  }
}

func arg(_ name: String, in args: [String]) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

var activeRecorder: Recorder?

// If this process dies mid-capture (crash, uncaught exception) without calling
// stopCapture, replayd keeps the stream alive for a client that no longer
// exists: the system shows an "Unknown" recorder and DRM video (Netflix) goes
// black until replayd restarts. Best-effort synchronous stop before dying.
func emergencyStopCapture() {
  guard let stream = activeRecorder?.stream else { return }
  let done = DispatchSemaphore(value: 0)
  DispatchQueue.global().async {
    stream.stopCapture { _ in done.signal() }
  }
  _ = done.wait(timeout: .now() + 2)
}

func installCrashGuards() {
  NSSetUncaughtExceptionHandler { _ in emergencyStopCapture() }
  for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGHUP] {
    signal(sig) { s in
      emergencyStopCapture()
      signal(s, SIG_DFL)
      raise(s)
    }
  }
}
var signalSources: [DispatchSourceSignal] = []

func runRecord(_ args: [String]) async {
  guard let out = arg("--out", in: args) else { fail("--out is required", code: 2) }
  let displayID = UInt32(arg("--display", in: args) ?? "0") ?? 0
  let fps = Int(arg("--fps", in: args) ?? "30") ?? 30
  let systemAudio = args.contains("--system-audio")
  let mic = arg("--mic", in: args)

  let url = URL(fileURLWithPath: out)
  try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try? FileManager.default.removeItem(at: url)

  let recorder = Recorder(outURL: url)
  activeRecorder = recorder
  installCrashGuards()

  let requestStop: () -> Void = { Task { @MainActor in await recorder.stop() } }
  for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler(handler: requestStop)
    src.resume()
    signalSources.append(src)
  }
  // "q" on stdin also stops (useful when signals are awkward to deliver).
  FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    // EOF (stdin closed or /dev/null): stop watching instead of spinning.
    if data.isEmpty { handle.readabilityHandler = nil; return }
    if String(data: data, encoding: .utf8)?.contains("q") == true { requestStop() }
  }

  await recorder.start(displayID: displayID, fps: fps, systemAudio: systemAudio, mic: mic)
}

let argv = Array(CommandLine.arguments.dropFirst())

switch argv.first {
case "list":
  Task { @MainActor in await runList() }
case "record":
  Task { @MainActor in await runRecord(argv) }
default:
  fail("usage: vidmyo-capture list | record --display <id> --out <file> [--fps N] [--system-audio] [--mic <uid|default>]", code: 2)
}
// ScreenCaptureKit shows a menu-bar recording indicator, which needs a running
// AppKit main loop; a bare dispatchMain() crashes inside SCStatusItem.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
