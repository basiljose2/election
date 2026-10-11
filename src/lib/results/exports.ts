import type { PostResult, CandidateOutcome } from "./compute";
import type { ResultDocument, StoredResult } from "./declare";

/**
 * Exports of a declared Result. Each is built from the stored, signed snapshot only (never by
 * recounting) and carries the Result hash.
 */

const OUTCOME_LABEL: Record<CandidateOutcome, string> = {
  elected: "Elected",
  tied: "Tied",
  not_elected: "Not elected",
  unopposed: "Elected unopposed",
  withheld: "Withheld",
};

const POST_STATUS_LABEL: Record<PostResult["status"], string> = {
  elected: "Elected",
  tie: "Tie",
  unopposed: "Unopposed",
  withheld: "Withheld - integrity check failed",
};

export const outcomeLabel = (outcome: CandidateOutcome) => OUTCOME_LABEL[outcome];
export const postStatusLabel = (status: PostResult["status"]) => POST_STATUS_LABEL[status];

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  // Quote anything with a delimiter, quote or newline; neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One row per Candidate (and NOTA) per Post, then one per booth, with the hash on every row. */
export function resultCsv(result: StoredResult): string {
  const doc = result.document;
  const header = [
    "result_hash",
    "scope",
    "booth",
    "post",
    "seats",
    "post_status",
    "candidate",
    "serial",
    "votes",
    "outcome",
    "margin",
  ];
  const lines = [header.join(",")];
  const row = (cells: Array<string | number | null>) => lines.push(cells.map(csvCell).join(","));

  for (const post of doc.posts) {
    for (const c of post.candidates) {
      row([
        result.resultHash,
        "total",
        "",
        post.name,
        post.seats,
        postStatusLabel(post.status),
        c.name,
        c.serial,
        c.votes,
        outcomeLabel(c.outcome),
        post.margin,
      ]);
    }
    if (post.nota !== null) {
      row([
        result.resultHash,
        "total",
        "",
        post.name,
        post.seats,
        postStatusLabel(post.status),
        "NOTA",
        null,
        post.nota,
        post.notaExceededWinner ? "NOTA exceeded winner" : "Not elected",
        post.margin,
      ]);
    }
  }
  const names = new Map(doc.posts.flatMap((p) => p.candidates.map((c) => [c.id, c.name] as const)));
  const postNames = new Map(doc.posts.map((p) => [p.postId, p.name]));
  for (const entry of doc.booth_wise) {
    for (const r of entry.rows) {
      row([
        result.resultHash,
        "booth",
        entry.booth_name,
        postNames.get(entry.post_id) ?? entry.post_id,
        null,
        "",
        r.candidate_id ? (names.get(r.candidate_id) ?? r.candidate_id) : "NOTA",
        null,
        r.votes,
        "",
        null,
      ]);
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The signed canonical JSON with its hash and signature, as one verifiable envelope. */
export function resultJson(result: StoredResult, publicKey: string): string {
  return JSON.stringify(
    {
      format: "campus-evm-result/v1",
      result_hash: result.resultHash,
      signature: result.signature,
      signature_algorithm: "Ed25519",
      public_key: publicKey,
      verification:
        "result_hash = hex(SHA-256(UTF-8(canonical_json))); signature = Ed25519 over the UTF-8 bytes of canonical_json, base64url",
      canonical_json: result.canonicalJson,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------------- PDF

const PAGE = { width: 595, height: 842, margin: 50, lineHeight: 14, fontSize: 10 };

/** Helvetica (WinAnsi) can show Latin-1 only: other characters are transliterated or "?". */
function pdfText(text: string): string {
  const plain = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");
  return plain.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text: string, max: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > max) {
      if (line) out.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function documentLines(
  doc: ResultDocument,
): Array<{ text: string; bold?: boolean; gap?: boolean }> {
  const lines: Array<{ text: string; bold?: boolean; gap?: boolean }> = [];
  const add = (text: string, bold = false) => lines.push({ text, bold });
  const gap = () => lines.push({ text: "", gap: true });
  const names = new Map(doc.posts.flatMap((p) => p.candidates.map((c) => [c.id, c.name] as const)));

  add(`Election results: ${doc.election_name}`, true);
  add(`Declared at ${doc.declared_at}`);
  add(
    `Ballots cast ${doc.totals.ballots_cast} | Ballots cancelled ${doc.totals.ballots_cancelled} | Booths ${doc.totals.booths}`,
  );
  gap();
  for (const post of doc.posts) {
    add(
      `${post.name} (${post.seats} seat${post.seats === 1 ? "" : "s"}): ${postStatusLabel(post.status)}`,
      true,
    );
    if (post.status === "withheld") {
      add(`  Withheld: ${post.withheldReason ?? "integrity check failed"}. No counts are shown.`);
    }
    for (const c of post.candidates) {
      const votes = c.votes === null ? "" : `${c.votes} votes  `;
      add(`  ${c.serial ?? "-"}. ${c.name}  ${votes}${outcomeLabel(c.outcome)}`);
    }
    if (post.nota !== null) {
      add(`  NOTA  ${post.nota} votes${post.notaExceededWinner ? "  (NOTA exceeded winner)" : ""}`);
    }
    if (post.status === "tie") add(`  ${post.tiedSeats} seat(s) tied: not resolved by the system.`);
    if (post.margin !== null) add(`  Margin: ${post.margin}`);
    gap();
  }
  if (doc.booth_wise.length > 0) {
    add("Booth-wise votes", true);
    const postNames = new Map(doc.posts.map((p) => [p.postId, p.name]));
    for (const entry of doc.booth_wise) {
      add(`${entry.booth_name} - ${postNames.get(entry.post_id) ?? entry.post_id}`);
      for (const r of entry.rows) {
        add(
          `  ${r.candidate_id ? (names.get(r.candidate_id) ?? r.candidate_id) : "NOTA"}: ${r.votes}`,
        );
      }
    }
  }
  return lines;
}

/**
 * A deterministic, text-only PDF (Helvetica, A4). The Result hash is printed in the footer of
 * every page, in plain text so it can be found and compared. No dependencies and no
 * timestamps other than the declaration time, so the same Result always gives the same file.
 */
export function resultPdf(result: StoredResult): Buffer {
  const maxChars = 95;
  const lines = documentLines(result.document).flatMap((l) =>
    l.gap
      ? [l]
      : wrap(l.text, maxChars).map((text, i) => ({ text: i ? `    ${text}` : text, bold: l.bold })),
  );
  const perPage = Math.floor((PAGE.height - 2 * PAGE.margin - 30) / PAGE.lineHeight);
  const pages: Array<typeof lines> = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([]);

  const objects: string[] = [];
  const addObject = (body: string) => objects.push(body) && objects.length;
  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  addObject("PLACEHOLDER_PAGES");
  const regular = addObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const bold = addObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  void catalogId;

  const pageIds: number[] = [];
  pages.forEach((pageLines, index) => {
    const ops: string[] = [];
    let y = PAGE.height - PAGE.margin;
    for (const line of pageLines) {
      if (!("gap" in line && line.gap)) {
        ops.push(
          `BT /${line.bold ? "F2" : "F1"} ${PAGE.fontSize} Tf ${PAGE.margin} ${y} Td (${pdfText(line.text)}) Tj ET`,
        );
      }
      y -= PAGE.lineHeight;
    }
    const footer = `Result hash: ${result.resultHash}   Page ${index + 1} of ${pages.length}`;
    ops.push(`BT /F1 8 Tf ${PAGE.margin} ${PAGE.margin - 20} Td (${pdfText(footer)}) Tj ET`);
    const stream = ops.join("\n");
    const contentId = addObject(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
    const pageId = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> >>`,
    );
    pageIds.push(pageId);
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
