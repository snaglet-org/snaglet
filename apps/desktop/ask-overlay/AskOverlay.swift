import Cocoa
import WebKit

// System-wide window for agent asks (questions and tool permissions). Unlike the
// click-through cursor overlay this window takes mouse and keyboard input, so it exists
// only while an ask is pending: the page reports the height of its card stack, the
// window sizes itself to it, and it is hidden (ordered out) when nothing is pending.
//   AskOverlay <ask-overlay-url>

let args = CommandLine.arguments
guard args.count >= 2, let parsedURL = URL(string: args[1]) else {
    FileHandle.standardError.write(Data("usage: AskOverlay <ask-overlay-url>\n".utf8))
    exit(2)
}
let overlayURL: URL = parsedURL

let panelWidth: CGFloat = 372
let screenMargin: CGFloat = 16
let maxHeightFraction: CGFloat = 0.9
let selfExpiryTicks = 30  // 30 ticks x 0.5 s = 15 s of consecutive not-ready
let launchGraceSeconds: TimeInterval = 30

// Returns the card stack height in px (0 = nothing pending) once the page has set its
// marker and no Vite error overlay is present; -1 while not ready.
let stateScript =
    "(function(){if(document.documentElement.getAttribute('data-snaglet-ask-overlay')!=='1'"
    + "||document.querySelector('vite-error-overlay'))return -1;"
    + "var r=document.querySelector('.snaglet-agent-popups');"
    + "return r?Math.ceil(r.getBoundingClientRect().height):0;})()"

/// Borderless panel that can take keyboard focus (for text answers) without activating
/// the app, so it never pulls Snaglet or the user's current app to the front.
final class AskPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class AskDelegate: NSObject, NSApplicationDelegate {
    var panel: AskPanel?
    var web: WKWebView?
    var statusItem: NSStatusItem?
    var readyTimer: Timer?
    var shownHeight: CGFloat = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.screens.first else { exit(1) }
        let panel = AskPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 100),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating  // below the Dock and menu bar, above app windows
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false

        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "SnagletAskOverlay"
        let view = WKWebView(frame: panel.contentRect(forFrameRect: panel.frame), configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.autoresizingMask = [.width, .height]
        panel.contentView = view
        view.load(URLRequest(url: overlayURL))
        self.panel = panel
        self.web = view
        _ = screen

        let launchedAt = Date()
        var notReadyTicks = 0
        readyTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.web?.evaluateJavaScript(stateScript) { result, _ in
                let height = CGFloat((result as? NSNumber)?.doubleValue ?? -1)
                if height < 0 {
                    self?.hide()
                    notReadyTicks += 1
                    // 0.25 s per tick here, so scale the shared 15 s budget.
                    if notReadyTicks >= selfExpiryTicks * 2
                        && Date().timeIntervalSince(launchedAt) >= launchGraceSeconds {
                        FileHandle.standardError.write(Data("AskOverlay: page not ready for 15s; quitting\n".utf8))
                        exit(0)
                    }
                    return
                }
                notReadyTicks = 0
                if height == 0 { self?.hide() } else { self?.show(height: height) }
            }
        }

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "?"
        item.button?.toolTip = "Snaglet agent asks"
        let menu = NSMenu()
        let quit = NSMenuItem(title: "Quit ask overlay", action: #selector(quit), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item
    }

    func show(height: CGFloat) {
        guard let panel = panel, let screen = NSScreen.screens.first else { return }
        let h = min(height, screen.visibleFrame.height * maxHeightFraction)
        let frame = NSRect(
            x: screen.visibleFrame.maxX - panelWidth - screenMargin,
            y: screen.visibleFrame.minY + screenMargin,
            width: panelWidth, height: h)
        if panel.frame != frame { panel.setFrame(frame, display: true) }
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    func hide() {
        if panel?.isVisible == true { panel?.orderOut(nil) }
    }

    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AskDelegate()
app.delegate = delegate
app.run()
