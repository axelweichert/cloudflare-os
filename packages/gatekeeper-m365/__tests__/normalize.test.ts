import { describe, expect, it } from "vitest";
import {
  accountUrl,
  normalizeEvent,
  normalizeMessage,
  normalizeMessageSummary,
  normalizeProfile,
  normalizeTask,
  normalizeTaskList,
  type GraphEventResponse,
  type GraphMessageResponse,
  type GraphTaskListResponse,
  type GraphTaskResponse,
  type GraphUserResponse,
} from "../src/m365-api";

describe("normalizeProfile", () => {
  it("prefers mail, falls back to userPrincipalName", () => {
    expect(normalizeProfile({ id: "1", displayName: "Axel", mail: "a@x.at", userPrincipalName: "a@x.onmicrosoft.com", jobTitle: "CEO" }))
      .toEqual({ id: "1", displayName: "Axel", email: "a@x.at", jobTitle: "CEO" });
    expect(normalizeProfile({ id: "1", userPrincipalName: "a@x.at" }).email).toBe("a@x.at");
    expect(normalizeProfile({ id: "1" }).email).toBeNull();
  });
});

describe("normalizeMessageSummary", () => {
  it("maps recipients and defaults", () => {
    const raw: GraphMessageResponse = {
      id: "m1",
      subject: "Hello",
      bodyPreview: "hi there",
      from: { emailAddress: { name: "Bob", address: "bob@x.at" } },
      toRecipients: [{ emailAddress: { name: "Me", address: "me@x.at" } }, { emailAddress: {} }],
      receivedDateTime: "2026-09-27T10:00:00Z",
      isRead: false,
      hasAttachments: true,
    };
    const s = normalizeMessageSummary(raw);
    expect(s.from).toEqual({ name: "Bob", address: "bob@x.at" });
    expect(s.toRecipients).toEqual([{ name: "Me", address: "me@x.at" }, { name: null, address: null }]);
    expect(s.isRead).toBe(false);
    expect(s.hasAttachments).toBe(true);
    expect(s.webLink).toBeNull();
  });

  it("handles a bare message with no fields", () => {
    const s = normalizeMessageSummary({ id: "m2" });
    expect(s).toMatchObject({ id: "m2", subject: null, preview: "", from: null, toRecipients: [], isRead: false });
  });
});

describe("normalizeMessage", () => {
  it("carries body and content type", () => {
    const raw: GraphMessageResponse = { id: "m3", body: { contentType: "HTML", content: "<p>x</p>" } };
    const m = normalizeMessage(raw);
    expect(m.bodyContentType).toBe("html");
    expect(m.body).toBe("<p>x</p>");
  });
  it("defaults body content type to text", () => {
    expect(normalizeMessage({ id: "m4" }).bodyContentType).toBe("text");
  });
});

describe("normalizeEvent", () => {
  it("flags recurrence and maps times", () => {
    const raw: GraphEventResponse = {
      id: "e1",
      subject: "Standup",
      start: { dateTime: "2026-09-28T09:00:00", timeZone: "Europe/Vienna" },
      end: { dateTime: "2026-09-28T09:15:00", timeZone: "Europe/Vienna" },
      isAllDay: false,
      location: { displayName: "Room 1" },
      organizer: { emailAddress: { name: "Boss", address: "boss@x.at" } },
      attendees: [{ emailAddress: { name: "A", address: "a@x.at" } }],
      type: "occurrence",
    };
    const e = normalizeEvent(raw);
    expect(e.start).toBe("2026-09-28T09:00:00");
    expect(e.timeZone).toBe("Europe/Vienna");
    expect(e.location).toBe("Room 1");
    expect(e.attendees).toEqual([{ name: "A", address: "a@x.at" }]);
    expect(e.isRecurring).toBe(true);
  });
  it("non-recurring single event", () => {
    expect(normalizeEvent({ id: "e2", type: "singleInstance" }).isRecurring).toBe(false);
  });
});

describe("normalizeTaskList / normalizeTask", () => {
  it("marks the default list", () => {
    const raw: GraphTaskListResponse = { id: "l1", displayName: "Tasks", wellknownListName: "defaultList" };
    expect(normalizeTaskList(raw)).toEqual({ id: "l1", displayName: "Tasks", isDefault: true });
    expect(normalizeTaskList({ id: "l2", displayName: "Work" }).isDefault).toBe(false);
  });
  it("derives isCompleted from status and truncates preview", () => {
    const raw: GraphTaskResponse = { id: "t1", title: "Do", status: "completed", body: { content: "x".repeat(500) } };
    const t = normalizeTask(raw);
    expect(t.isCompleted).toBe(true);
    expect(t.preview.length).toBe(280);
    expect(normalizeTask({ id: "t2", title: "Todo" }).isCompleted).toBe(false);
  });
});

describe("accountUrl", () => {
  it("builds an Outlook web link from the UPN", () => {
    const user: GraphUserResponse = { id: "u1", userPrincipalName: "axel@weichert.at" };
    expect(accountUrl(user)).toBe("https://outlook.office.com/mail/axel%40weichert.at");
  });
});
