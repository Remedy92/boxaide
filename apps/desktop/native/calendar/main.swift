/**
 * boxaide-calendar — the macOS half of the local calendar provider.
 *
 * One process per request: the Node side spawns this, reads one JSON reply on
 * stdout, and the process exits. That shape is deliberate. EventKit is a Cocoa
 * framework with its own run loop expectations and a permission prompt that can
 * block for as long as the user stares at it; a long-lived helper would have to
 * keep that state alive next to Electron's. A short process cannot leak it.
 *
 * stdout is JSON and nothing else. Every diagnostic goes to stderr, because a
 * stray print here is a parse error on the other side.
 *
 * Commands:
 *   probe                      -> {"ok":true,"access":"..."}          never prompts
 *   calendars                  -> {"ok":true,"calendars":[...]}
 *   events <startIso> <endIso> -> {"ok":true,"events":[...]}
 *   create                     -> {"ok":true,"eventId":..,"calendarId":..}  JSON on stdin
 *   delete <eventId>           -> {"ok":true,"deleted":bool}
 *
 * Any command may carry --no-prompt as a trailing argument. With it, a missing
 * permission is answered as `denied` straight away instead of raising the
 * system dialog. Every caller but the connect click passes it: a background
 * agenda read that puts a dialog on screen is then killed by its own read
 * timeout, which reports the user's hesitation as a failure.
 */
import AppKit
import EventKit
import Foundation

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone(identifier: "UTC")
    return f
}()

/// Accepts the fractional-second instants the server writes as well as plain
/// RFC 3339, because JavaScript's toISOString() always emits milliseconds.
func parseIso(_ text: String) -> Date? {
    if let date = iso.date(from: text) { return date }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    withFraction.timeZone = TimeZone(identifier: "UTC")
    return withFraction.date(from: text)
}

func emit(_ value: Any) {
    // .sortedKeys so a diff of two captured replies is readable, and so
    // fixtures in the Node tests are stable.
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

/// Errors are values, not exits: the Node side always gets one JSON object and
/// never has to distinguish "crashed" from "said no".
func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "error": message])
    exit(0)
}

/**
 * macOS 14 split the old all-or-nothing calendar permission in two, and the
 * deprecated requestAccessToEntityType now maps to write-only on some paths.
 * Reading the agenda needs full access, so that is what we ask for.
 *
 * The prompt is charged to the RESPONSIBLE process, which for a helper spawned
 * by Boxaide.app is Boxaide.app — so the usage string must live in the app's
 * Info.plist, not in this binary, and the user sees "Boxaide" in the dialog.
 * Unpackaged (`npm run dev`) the responsible process is Electron instead, so a
 * developer grants it once for Electron and again for the packaged build.
 */
func requestFullAccess(_ store: EKEventStore) -> Bool {
    let sema = DispatchSemaphore(value: 0)
    var granted = false
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, _ in granted = ok; sema.signal() }
    } else {
        store.requestAccess(to: .event) { ok, _ in granted = ok; sema.signal() }
    }
    sema.wait()
    return granted
}

func authorized() -> Bool {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) { return status == .fullAccess }
    return status == .authorized
}

func accessName() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted:    return "restricted"
    case .denied:        return "denied"
    case .fullAccess:    return "fullAccess"
    case .writeOnly:     return "writeOnly"
    default:             return "authorized"
    }
}

/// EKCalendar.color is an NSColor on macOS, not a CGColor.
func hex(_ color: NSColor) -> String {
    guard let c = color.usingColorSpace(.sRGB) else { return "" }
    let r = Int((c.redComponent * 255).rounded())
    let g = Int((c.greenComponent * 255).rounded())
    let b = Int((c.blueComponent * 255).rounded())
    return String(format: "#%02X%02X%02X", r, g, b)
}

/// EKSourceType as a stable string. Spelled out rather than sent as the raw
/// enum number, because the number is Apple's and would silently change meaning
/// if they ever inserted a case.
func sourceTypeName(_ type: EKSourceType?) -> String {
    switch type {
    case .some(.local): return "local"
    case .some(.exchange): return "exchange"
    case .some(.calDAV): return "caldav"
    case .some(.mobileMe): return "icloud"
    case .some(.subscribed): return "subscribed"
    case .some(.birthdays): return "birthdays"
    default: return ""
    }
}

func calendarPayload(_ cal: EKCalendar) -> [String: Any] {
    [
        "id": cal.calendarIdentifier,
        "name": cal.title,
        // The source is what makes this worth having: it is the account the
        // calendar came from ("Gmail", "iCloud", an Exchange server name), and
        // it is the only label a user recognises when two calendars are both
        // called "Calendar".
        "source": cal.source?.title ?? "",
        // The account KIND behind that title, which the title alone does not
        // give away: macOS labels a Google account with whatever the user
        // called it, so "work" and "personal" are both `calDAV` and only this
        // separates them from a local-only or subscribed calendar. The server
        // uses it to warn before the same account is connected twice.
        "sourceType": sourceTypeName(cal.source?.sourceType),
        "writable": cal.allowsContentModifications,
        "color": cal.color.map { hex($0) } ?? NSNull(),
    ]
}

func listCalendars(_ store: EKEventStore) -> [String: Any] {
    ["ok": true, "calendars": store.calendars(for: .event).map(calendarPayload)]
}

func listEvents(_ store: EKEventStore, from: Date, to: Date) -> [String: Any] {
    let all = store.calendars(for: .event)
    // predicateForEvents already unrolls recurrence, which is exactly the
    // contract CalendarProvider.listEvents states ("expanded instances").
    let predicate = store.predicateForEvents(withStart: from, end: to,
                                             calendars: all.isEmpty ? nil : all)
    let events = store.events(matching: predicate).map { ev -> [String: Any] in
        [
            "id": ev.eventIdentifier ?? "",
            "calendarId": ev.calendar?.calendarIdentifier ?? "",
            "title": ev.title ?? "",
            "start": iso.string(from: ev.startDate),
            "end": iso.string(from: ev.endDate),
            "allDay": ev.isAllDay,
            "location": ev.location ?? "",
            "status": ev.status == .canceled ? "cancelled"
                    : (ev.status == .tentative ? "tentative" : "confirmed"),
            "busy": ev.availability != .free,
        ]
    }
    return ["ok": true, "events": events]
}

/**
 * Writes the organiser's own copy. Attendees are NOT written: EKParticipant
 * cannot be constructed, so EventKit has no way to invite anyone. The emailed
 * iMIP REQUEST stays the only invite, exactly as src/calendar/service.ts
 * already insists — this row is the organiser's reminder, nothing more.
 *
 * The iCalendar UID is also not writable through EventKit. The event this
 * creates therefore carries a different identity to the invite that was
 * mailed; the meeting row keeps both, and the delete path below matches on
 * the EventKit identifier this returns.
 */
func createEvent(_ store: EKEventStore, _ input: [String: Any]) -> [String: Any] {
    guard let title = input["title"] as? String,
          let startText = input["start"] as? String,
          let endText = input["end"] as? String,
          let start = parseIso(startText),
          let end = parseIso(endText)
    else { fail("bad_request", "create needs title, start and end") }

    guard let calendar = store.defaultCalendarForNewEvents else {
        fail("no_calendar", "This Mac has no calendar that can hold new events")
    }
    let event = EKEvent(eventStore: store)
    event.calendar = calendar
    event.title = title
    event.startDate = start
    event.endDate = end
    if let notes = input["description"] as? String, !notes.isEmpty { event.notes = notes }
    if let place = input["location"] as? String, !place.isEmpty { event.location = place }
    do {
        try store.save(event, span: .thisEvent, commit: true)
    } catch {
        fail("write_failed", error.localizedDescription)
    }
    return [
        "ok": true,
        "eventId": event.eventIdentifier ?? "",
        "calendarId": calendar.calendarIdentifier,
    ]
}

/// False when the event is already gone, matching CalendarProvider.deleteEvent.
func deleteEvent(_ store: EKEventStore, _ eventId: String) -> [String: Any] {
    guard let event = store.event(withIdentifier: eventId) else {
        return ["ok": true, "deleted": false]
    }
    do {
        try store.remove(event, span: .thisEvent, commit: true)
    } catch {
        fail("delete_failed", error.localizedDescription)
    }
    return ["ok": true, "deleted": true]
}

func readStdin() -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("bad_request", "create needs a JSON object on stdin")
    }
    return parsed
}

let rawArgv = Array(CommandLine.arguments.dropFirst())
let noPrompt = rawArgv.contains("--no-prompt")
let argv = rawArgv.filter { $0 != "--no-prompt" }
let command = argv.first ?? "probe"

// `probe` answers without touching the store, so the Node side can learn "this
// binary runs on this Mac" without ever provoking the permission dialog.
if command == "probe" {
    emit(["ok": true, "access": accessName()])
    exit(0)
}

let store = EKEventStore()
if !authorized() {
    if noPrompt { fail("denied", "Calendar access was not granted") }
    if !requestFullAccess(store) { fail("denied", "Calendar access was not granted") }
}

switch command {
case "calendars":
    emit(listCalendars(store))
case "events":
    guard argv.count >= 3, let from = parseIso(argv[1]), let to = parseIso(argv[2]) else {
        fail("bad_request", "events needs <start-iso> <end-iso>")
    }
    emit(listEvents(store, from: from, to: to))
case "create":
    emit(createEvent(store, readStdin()))
case "delete":
    guard argv.count >= 2 else { fail("bad_request", "delete needs <event-id>") }
    emit(deleteEvent(store, argv[1]))
default:
    fail("bad_request", "unknown command \(command)")
}
