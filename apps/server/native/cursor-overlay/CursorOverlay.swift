// System-wide agent cursor overlay (macOS).
//
// One transparent window over the main display that loads Snaglet's overlay page
// (`/?cursorOverlay=1`), which draws each agent's avatar where its cursor is.
// Plus a menu-bar flower with two actions: stop the agent cursors, quit.
// Plus one small "flower panel" per flower the page says may take the mouse, so the
// person can hover it for its ×, or drag it out of the way.
//
// Safety, deliberately simple:
//   * The full-screen window ignores the mouse permanently. Its `ignoresMouseEvents` is
//     set once, below, and nothing in this file ever changes it, so it can never catch a
//     click or hold the keyboard.
//   * Only flower panels take the mouse, and only while the page reports their flower as
//     settled (still for >= 1 s; any new cursor event turns that off). Each is at most
//     120 x 120 pt, never key or main, and non-activating, so clicking one never brings Snaglet
//     forward or takes focus from the app the agent is driving. Without a fresh page read
//     for 0.25 s they all stop taking the mouse. The server waits 400 ms after its cursor
//     event before posting the agent's next mouse input, longer than this 0.1 s poll.
//   * No web-to-native bridge: the page cannot call into this program at all. The native
//     side reads the page and forwards the mouse on a panel to it (evaluateJavaScript).
//   * The menu-bar item is always available to stop or quit.
//   * Every window sits at .floating level: above normal windows, below the Dock and menu bar.
//   * The program quits by itself if the page is not ready for 15 s in a row.
//   * The window stays fully transparent (alpha 0), and no panel shows, until the loaded
//     page marks itself as the overlay page (and no Vite error overlay is up). If the URL
//     ever serves the normal app, or the page fails to load, nothing is drawn over the screen.
// A test (tests/unit/apps/desktop/cursorOverlaySafety.test.ts) enforces these.
//
// Usage: CursorOverlay <overlay-url> <api-url>
//   e.g. CursorOverlay "http://localhost:3200/?cursorOverlay=1" "http://localhost:4200"
// Esc (global, needs Input Monitoring permission) posts <api-url>/api/computer/stop.
// If the server is token-protected, set SNAGLET_AUTH_TOKEN in the environment; it is sent
// as the `x-snaglet-token` header (never on the command line or in a URL).

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 3, let parsedOverlayURL = URL(string: args[1]) else {
    FileHandle.standardError.write(Data("usage: CursorOverlay <overlay-url> <api-url>\n".utf8))
    exit(2)
}
let overlayURL: URL = parsedOverlayURL
let apiBase = args[2]

// A token-protected server (SNAGLET_AUTH_TOKEN) wants `x-snaglet-token` on every request.
// It is read from the environment (never argv or the URL) and never printed.
let authToken = ProcessInfo.processInfo.environment["SNAGLET_AUTH_TOKEN"] ?? ""

// When the Snaglet server spawns the overlay it passes its pid; if that process disappears
// (crash, force-quit) the overlay quits too instead of lingering over the desktop.
let parentPid: pid_t? = ProcessInfo.processInfo.environment["SNAGLET_OVERLAY_PARENT_PID"]
    .flatMap { Int32($0) }
    .flatMap { $0 > 0 ? $0 : nil }

func logStderr(_ message: String) {
    FileHandle.standardError.write(Data(("CursorOverlay: " + message + "\n").utf8))
}

func postStop() {
    guard let url = URL(string: apiBase + "/api/computer/stop") else {
        logStderr("stop failed: bad api url")
        return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    if !authToken.isEmpty { request.setValue(authToken, forHTTPHeaderField: "x-snaglet-token") }
    URLSession.shared.dataTask(with: request) { _, response, error in
        if let error = error {
            logStderr("stop request failed: \(error.localizedDescription)")
        } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            logStderr("stop request rejected: HTTP \(http.statusCode)")
        }
    }.resume()
}

// Page readiness: the standalone page's marker is set AND Vite's error overlay is
// absent (it would otherwise cover the whole display). Read-only; returns "1" or "0".
let readyScript =
    "(document.documentElement.getAttribute('data-snaglet-cursor-overlay') === '1' "
    + "&& !document.querySelector('vite-error-overlay')) ? '1' : '0'"
let selfExpiryTicks = 30  // 30 ticks x 0.5 s = 15 s of consecutive not-ready
let launchGraceSeconds: TimeInterval = 30  // first load may be slow

// Flower panels. The page reports each flower's grip rect (CSS px = points, top-left
// origin on the main display) and whether it may take the mouse now; read-only.
let flowerPollSeconds: TimeInterval = 0.1
let flowerReadStaleSeconds: TimeInterval = 0.25
let flowerPanelMaxSide: CGFloat = 120
let flowerPanelMaxCount = 8
let maxAgentIdLength = 200
// With a panel up, a main thread stalled this long quits the program (its panels with it).
let mainStallSeconds: TimeInterval = 1.0
let flowersScript =
    "(function(){if(document.documentElement.getAttribute('data-snaglet-cursor-overlay')!=='1'"
    + "||document.querySelector('vite-error-overlay'))return '';"
    + "var f=window.__snagletCursorFlowers;return typeof f==='function'?String(f()):'';})()"

struct FlowerGrip {
    let id: String
    let rect: CGRect  // top-left origin, points
}

/// A monotonic clock (seconds since boot, not counting sleep), immune to wall-clock steps.
func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

/// Parse the page's report, keeping only well-formed, small, settled grips. Nil when the
/// page is not ready or the reply is malformed.
func parseFlowerReport(_ json: String) -> [FlowerGrip]? {
    guard let data = json.data(using: .utf8),
          let report = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let items = report["flowers"] as? [[String: Any]]
    else { return nil }
    var grips: [FlowerGrip] = []
    for item in items {
        guard grips.count < flowerPanelMaxCount,
              let id = item["id"] as? String, !id.isEmpty, id.count <= maxAgentIdLength,
              (item["live"] as? Bool) == true,
              let x = (item["x"] as? NSNumber)?.doubleValue,
              let y = (item["y"] as? NSNumber)?.doubleValue,
              let w = (item["w"] as? NSNumber)?.doubleValue,
              let h = (item["h"] as? NSNumber)?.doubleValue,
              x.isFinite, y.isFinite, w.isFinite, h.isFinite,
              w > 0, h > 0, CGFloat(w) <= flowerPanelMaxSide, CGFloat(h) <= flowerPanelMaxSide
        else { continue }
        grips.append(FlowerGrip(id: id, rect: CGRect(x: x, y: y, width: w, height: h)))
    }
    return grips
}

/// The main thread's last flower tick, read by the watchdog thread.
final class MainThreadWatch: @unchecked Sendable {
    private let lock = NSLock()
    private var lastTick = ProcessInfo.processInfo.systemUptime
    private var panelsUp = false

    func tick(panelsUp up: Bool) {
        lock.lock()
        lastTick = ProcessInfo.processInfo.systemUptime
        panelsUp = up
        lock.unlock()
    }

    /// A panel was up at the last tick and the main thread has not ticked since.
    func stalled(after seconds: TimeInterval) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return panelsUp && ProcessInfo.processInfo.systemUptime - lastTick > seconds
    }
}

let mainWatch = MainThreadWatch()

/// A small panel over one flower. It never becomes key or main, and as a non-activating
/// panel a click on it never activates Snaglet or takes focus from the app the agent is using.
final class FlowerPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Forwards the mouse on a flower panel to the page, which decides what it means.
final class FlowerHitView: NSView {
    var agentId = ""
    var forward: ((String, String) -> Void)?
    private var hovering = false
    /// A press on this panel has not been reported as ended to the page yet.
    private(set) var pressed = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    // A nearly invisible fill, so the window server never treats the panel as see-through.
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0, alpha: 0.01).setFill()
        dirtyRect.fill()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
            owner: self, userInfo: nil))
    }

    func setHover(_ on: Bool) {
        guard on != hovering else { return }
        hovering = on
        forward?(on ? "hover" : "leave", agentId)
    }

    override func mouseEntered(with event: NSEvent) { setHover(true) }
    override func mouseMoved(with event: NSEvent) { setHover(true) }
    override func mouseExited(with event: NSEvent) { setHover(false) }
    override func mouseDown(with event: NSEvent) {
        pressed = true
        forward?("down", agentId)
    }
    override func mouseDragged(with event: NSEvent) { forward?("move", agentId) }
    override func mouseUp(with event: NSEvent) { endPress("up") }

    /// End a press the page still thinks is going: "up" where the button came up, "cancel"
    /// when the panel goes away under it (the page then drops the drag and lets go of its grab).
    /// A dragged panel stayed at its old spot, so it stops taking the mouse at once; the next
    /// poll puts it where the flower now is.
    func endPress(_ kind: String) {
        guard pressed else { return }
        pressed = false
        if let panel = window as? FlowerPanel {
            panel.ignoresMouseEvents = true
        }
        forward?(kind, agentId)
    }
}

/// The pink blossom, drawn for the menu bar.
func blossomImage(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
        guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
        ctx.translateBy(x: rect.midX, y: rect.midY)
        ctx.scaleBy(x: size / 40.0, y: size / 40.0)
        for i in 0..<6 {
            ctx.saveGState()
            ctx.rotate(by: CGFloat(i) * .pi / 3)
            ctx.setFillColor(NSColor(calibratedRed: 1, green: 0.62, blue: 0.78, alpha: 1).cgColor)
            ctx.fillEllipse(in: CGRect(x: -6.5, y: 5, width: 13, height: 16))
            ctx.setStrokeColor(NSColor(calibratedRed: 0.93, green: 0.4, blue: 0.62, alpha: 1).cgColor)
            ctx.setLineWidth(1.4)
            ctx.strokeEllipse(in: CGRect(x: -6.5, y: 5, width: 13, height: 16))
            ctx.restoreGState()
        }
        ctx.setFillColor(NSColor(calibratedRed: 1, green: 0.85, blue: 0.25, alpha: 1).cgColor)
        ctx.fillEllipse(in: CGRect(x: -6, y: -6, width: 12, height: 12))
        return true
    }
    image.isTemplate = false
    return image
}

final class OverlayDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var web: WKWebView?
    var statusItem: NSStatusItem?
    var keyMonitor: Any?
    var readyTimer: Timer?
    var flowerTimer: Timer?
    var watchdog: DispatchSourceTimer?
    var flowerPanels: [String: FlowerPanel] = [:]
    /// Uptime of the last page reply applied, and request numbers to keep replies in order.
    var lastFlowerRead: TimeInterval = -.infinity
    var flowerRequest = 0
    var lastAppliedRequest = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        // screens.first is the menu-bar (primary) display, which is what CGMainDisplayID()
        // and the server's pointer coordinates use. NSScreen.main follows the key window.
        guard let screen = NSScreen.screens.first else { exit(1) }

        let window = NSWindow(
            contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true  // permanent: never toggled anywhere
        // .floating (level 3): above normal app windows, but below the Dock (20) and
        // the menu bar (24), so a misbehaving overlay can never cover them.
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.isReleasedWhenClosed = false
        window.alphaValue = 0  // revealed only once the page proves it is the overlay

        // The page only reports itself as the system overlay when it sees this user agent.
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "SnagletCursorOverlay"
        // A token-protected (packaged) server rejects the page's API calls without the
        // session token, so its heartbeat never lands and the in-app overlay keeps
        // drawing a second flower. Hand the page the same runtime config the Tauri shell
        // injects (apiBaseUrl + token) so it authenticates. This is a document-start
        // script, not a bridge: the page still cannot message native code.
        if !authToken.isEmpty {
            let runtime: [String: String] = ["apiBaseUrl": apiBase + "/api", "token": authToken]
            if let data = try? JSONSerialization.data(withJSONObject: runtime),
               let json = String(data: data, encoding: .utf8) {
                config.userContentController.addUserScript(WKUserScript(
                    source: "window.__SNAGLET_DESKTOP__ = \(json);",
                    injectionTime: .atDocumentStart, forMainFrameOnly: true))
            }
        }
        let view = WKWebView(frame: screen.frame, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        view.load(URLRequest(url: overlayURL))
        window.orderFrontRegardless()
        self.window = window
        self.web = view

        // Show the window only while the page says it is the overlay page AND no Vite
        // error overlay (a full-screen custom element) is present. If the page is not
        // ready for 15 s in a row (after a 30 s launch grace), this program quits.
        let launchedAt = Date()
        var notReadyTicks = 0
        // Timers run in the common modes so menu tracking (the menu-bar flower) never pauses them.
        let ready = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            if let pid = parentPid, kill(pid, 0) != 0, errno == ESRCH {
                logStderr("Snaglet server (pid \(pid)) is gone; quitting")
                exit(0)
            }
            self?.web?.evaluateJavaScript(readyScript) { result, _ in
                let ready = (result as? String) == "1"
                self?.window?.alphaValue = ready ? 1 : 0
                if ready {
                    notReadyTicks = 0
                } else {
                    notReadyTicks += 1
                    if notReadyTicks >= selfExpiryTicks && Date().timeIntervalSince(launchedAt) >= launchGraceSeconds {
                        logStderr("overlay page not ready for 15s; quitting")
                        exit(0)
                    }
                }
            }
        }
        RunLoop.main.add(ready, forMode: .common)
        readyTimer = ready

        let flowers = Timer(timeInterval: flowerPollSeconds, repeats: true) { [weak self] _ in
            self?.pollFlowers()
        }
        RunLoop.main.add(flowers, forMode: .common)
        flowerTimer = flowers

        // A hung main thread could leave a panel taking the mouse with no one to turn it off;
        // a separate thread quits the program then, which removes every window it owns.
        let dog = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "snaglet.cursor-overlay.watchdog"))
        dog.schedule(deadline: .now() + .seconds(1), repeating: .milliseconds(250))
        dog.setEventHandler {
            if mainWatch.stalled(after: mainStallSeconds) {
                logStderr("main thread stalled with a flower panel up; quitting")
                _exit(0)  // straight out: no exit handlers from this background thread
            }
        }
        dog.resume()
        watchdog = dog

        // Menu-bar flower: always a way to stop the cursors or quit.
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = blossomImage(size: 18)
        item.button?.toolTip = "Snaglet agent cursors"
        let menu = NSMenu()
        let stop = NSMenuItem(title: "Stop agent cursors", action: #selector(stopCursors), keyEquivalent: "")
        stop.target = self
        menu.addItem(stop)
        menu.addItem(NSMenuItem.separator())
        let quit = NSMenuItem(title: "Quit cursor overlay", action: #selector(quit), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item

        // Global Esc = kill switch. Silently inactive without Input Monitoring.
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { postStop() }
        }

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let screen = NSScreen.screens.first else { return }
            self?.window?.setFrame(screen.frame, display: true)
        }
    }

    @objc func stopCursors() { postStop() }

    @objc func quit() { NSApp.terminate(nil) }

    // MARK: Flower panels

    func pollFlowers() {
        defer { mainWatch.tick(panelsUp: !flowerPanels.isEmpty) }
        // A press whose mouseUp never reached its panel (the button came up elsewhere) is
        // ended here; one still held keeps reporting so the page knows the drag is alive.
        for panel in flowerPanels.values {
            guard let view = panel.contentView as? FlowerHitView, view.pressed else { continue }
            if NSEvent.pressedMouseButtons & 1 == 0 {
                view.endPress("up")
            } else {
                forwardFlowerInput("move", agentId: view.agentId)
            }
        }
        // A page that stopped answering may have missed the agent's next event: let go.
        if uptime() - lastFlowerRead > flowerReadStaleSeconds { releaseFlowers(keeping: []) }
        guard let window = window, window.alphaValue > 0.5 else {
            releaseFlowers(keeping: [])
            return
        }
        flowerRequest += 1
        let request = flowerRequest
        let sentAt = ProcessInfo.processInfo.systemUptime
        web?.evaluateJavaScript(flowersScript) { [weak self] result, _ in
            guard let self = self else { return }
            guard let report = parseFlowerReport((result as? String) ?? "") else {
                self.releaseFlowers(keeping: [])
                return
            }
            // Drop a reply that arrives out of order, or late (after a hang on either side):
            // it may show a flower as settled that a newer event has since made click-through.
            guard request > self.lastAppliedRequest,
                  ProcessInfo.processInfo.systemUptime - sentAt <= flowerReadStaleSeconds
            else { return }
            self.lastAppliedRequest = request
            self.lastFlowerRead = uptime()
            self.showFlowers(report)
        }
    }

    func showFlowers(_ grips: [FlowerGrip]) {
        guard let screen = NSScreen.screens.first else {
            releaseFlowers(keeping: [])
            return
        }
        // Panels stay on the main display, clipped to it. The panel that got a mouse-down keeps
        // getting the drag wherever it goes (even onto another display), so while pressed it
        // is left exactly as it is.
        let placed: [(FlowerGrip, NSRect)] = grips.compactMap { grip in
            if let panel = flowerPanels[grip.id], (panel.contentView as? FlowerHitView)?.pressed == true {
                return (grip, panel.frame)
            }
            let frame = NSRect(
                x: screen.frame.minX + grip.rect.minX,
                y: screen.frame.maxY - grip.rect.maxY,
                width: grip.rect.width, height: grip.rect.height
            ).intersection(screen.frame)
            return frame.isNull || frame.width < 1 || frame.height < 1 ? nil : (grip, frame)
        }
        releaseFlowers(keeping: Set(placed.map { $0.0.id }))
        for (grip, frame) in placed {
            let panel = flowerPanels[grip.id] ?? makeFlowerPanel(agentId: grip.id)
            if panel.frame != frame { panel.setFrame(frame, display: false) }
            panel.ignoresMouseEvents = false  // only here, for a grip the page reports as settled
            if !panel.isVisible { panel.orderFrontRegardless() }
        }
        if !placed.isEmpty { mainWatch.tick(panelsUp: true) }
    }

    /// Every panel not in `keeping` stops taking the mouse and goes away.
    func releaseFlowers(keeping: Set<String>) {
        for (id, panel) in flowerPanels where !keeping.contains(id) {
            panel.ignoresMouseEvents = true
            panel.orderOut(nil)
            let view = panel.contentView as? FlowerHitView
            view?.endPress("cancel")
            view?.setHover(false)
            flowerPanels.removeValue(forKey: id)
        }
    }

    func makeFlowerPanel(agentId: String) -> FlowerPanel {
        let panel = FlowerPanel(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating  // same level as the overlay window
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.acceptsMouseMovedEvents = true
        let view = FlowerHitView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        view.autoresizingMask = [.width, .height]
        view.agentId = agentId
        view.forward = { [weak self] kind, id in self?.forwardFlowerInput(kind, agentId: id) }
        panel.contentView = view
        flowerPanels[agentId] = panel
        return panel
    }

    /// Hand the mouse on a panel to the page (screen points, top-left origin). The values
    /// are serialized as JSON, never spliced into the script as raw text.
    func forwardFlowerInput(_ kind: String, agentId: String) {
        guard let screen = NSScreen.screens.first else { return }
        let at = NSEvent.mouseLocation
        let input: [String: Any] = [
            "kind": kind, "agentId": agentId,
            "x": Double(at.x - screen.frame.minX), "y": Double(screen.frame.maxY - at.y),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: input),
              let json = String(data: data, encoding: .utf8) else { return }
        web?.evaluateJavaScript(
            "window.__snagletCursorFlowerInput&&window.__snagletCursorFlowerInput(\(json))",
            completionHandler: nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = OverlayDelegate()
app.delegate = delegate
app.run()
