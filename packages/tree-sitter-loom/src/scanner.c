#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum TokenType {
  FENCE_LINE,
  FIELD_LINE,
  HEADING_LINE,
  ARROW_LINE,
  TILDE_LINE,
  PROSE_LINE,
  CODE_LINE,
  CODE_FENCE_LINE,
  TOC_LINE,
  VERBATIM_LINE,
  NOTE_LINE,
  NOTE_BODY_LINE,
  NEWLINE,
  ERROR_SENTINEL,
};

enum Mode { PREAMBLE, CODE, PROSE };

typedef struct {
  bool at_line_start;
  bool started;
  bool seen_heading;
  bool in_frontmatter;
  bool in_toc;
  uint8_t quote_length;
  uint8_t quote_column;
  bool in_note;
  uint8_t fenced_length;
  uint8_t fenced_column;
  bool awaiting_fence;
  uint8_t mode;
} Scanner;

#define HEAD_SIZE 48

typedef struct {
  char head[HEAD_SIZE];
  uint32_t head_length;
  uint32_t length;
  int32_t last_mark;
  bool toc;
} Line;

static bool is_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\v' || c == '\f' || c == '\r';
}

static char lower(int32_t c) {
  if (c >= 'A' && c <= 'Z') return (char)(c - 'A' + 'a');
  return c < 128 ? (char)c : '\x01';
}

static void peek_line(TSLexer *lexer, Line *line) {
  char window[5] = {0, 0, 0, 0, 0};
  memset(line, 0, sizeof(Line));
  line->last_mark = -1;
  while (!lexer->eof(lexer) && lexer->lookahead != '\n' &&
         lexer->lookahead != '\r') {
    int32_t c = lexer->lookahead;
    if (line->head_length < HEAD_SIZE)
      line->head[line->head_length++] = c < 128 ? (char)c : '\x01';
    if (!is_space(c)) line->last_mark = (int32_t)line->length;
    memmove(window, window + 1, 4);
    window[4] = lower(c);
    if (memcmp(window, "{toc}", 5) == 0) line->toc = true;
    line->length++;
    lexer->advance(lexer, false);
  }
}

static bool head_has(const Line *line, uint32_t at, const char *text) {
  uint32_t n = (uint32_t)strlen(text);
  return at + n <= line->head_length && memcmp(line->head + at, text, n) == 0;
}

static uint32_t indent_of(const Line *line) {
  uint32_t i = 0;
  while (i < line->head_length && is_space(line->head[i])) i++;
  return i;
}

static uint32_t hashes_of(const Line *line) {
  uint32_t i = 0;
  while (i < line->head_length && line->head[i] == '#') i++;
  return i;
}

static bool is_heading(const Line *line) {
  uint32_t hashes = hashes_of(line);
  return hashes >= 1 && hashes <= 6 && head_has(line, hashes, " ");
}

static bool is_frontmatter_fence(const Line *line) {
  return head_has(line, 0, "---") && line->last_mark == 2;
}

static bool is_arrow(const Line *line) {
  return head_has(line, indent_of(line), "=>");
}

static bool is_bare_arrow(const Line *line) {
  return is_arrow(line) && line->last_mark == (int32_t)indent_of(line) + 1;
}

static bool is_tilde(const Line *line) {
  return head_has(line, 0, "~") &&
         (line->length == 1 || is_space(line->head[1]));
}

static uint32_t fence_of(const Line *line, uint32_t *column) {
  uint32_t at = indent_of(line);
  uint32_t end = at;
  while (end < line->head_length && line->head[end] == '`') end++;
  *column = at;
  return end - at >= 3 ? end - at : 0;
}

static bool closes_fence(const Line *line, uint32_t length, uint32_t column) {
  uint32_t at;
  uint32_t found = fence_of(line, &at);
  return found >= length && at == column &&
         line->last_mark == (int32_t)(at + found) - 1;
}

static bool is_note_open(const Line *line) {
  return head_has(line, indent_of(line), ":::" "[Note]");
}

static bool is_note_close(const Line *line) {
  uint32_t at = indent_of(line);
  return head_has(line, at, ":::") && line->last_mark == (int32_t)at + 2;
}

static enum TokenType prose_kind(Scanner *s, const Line *line,
                                 enum TokenType kind, enum Mode mode) {
  uint32_t column;
  uint32_t length = fence_of(line, &column);
  s->mode = mode;
  s->quote_length = (uint8_t)(length > 255 ? 255 : length);
  s->quote_column = (uint8_t)(column > 255 ? 255 : column);
  s->in_note = length == 0 && is_note_open(line);
  if (length > 0) return VERBATIM_LINE;
  if (s->in_note) return NOTE_LINE;
  return kind;
}

static enum TokenType classify_line(Scanner *s, const Line *line) {
  bool first = !s->started;
  s->started = true;

  if (first && is_frontmatter_fence(line)) {
    s->in_frontmatter = true;
    s->mode = PREAMBLE;
    return FENCE_LINE;
  }

  if (s->in_frontmatter) {
    s->mode = PREAMBLE;
    if (is_frontmatter_fence(line)) {
      s->in_frontmatter = false;
      return FENCE_LINE;
    }
    return FIELD_LINE;
  }

  if (s->quote_length > 0) {
    if (closes_fence(line, s->quote_length, s->quote_column)) s->quote_length = 0;
    s->mode = s->seen_heading ? PROSE : PREAMBLE;
    return VERBATIM_LINE;
  }

  if (s->in_note) {
    s->in_note = !is_note_close(line);
    s->mode = s->seen_heading ? PROSE : PREAMBLE;
    return NOTE_BODY_LINE;
  }

  bool awaiting = s->awaiting_fence;
  s->awaiting_fence = false;

  if (s->fenced_length > 0) {
    if (closes_fence(line, s->fenced_length, s->fenced_column)) {
      s->fenced_length = 0;
      s->mode = PROSE;
      return CODE_FENCE_LINE;
    }
    s->mode = CODE;
    return CODE_LINE;
  }

  if (awaiting) {
    uint32_t column;
    uint32_t length = fence_of(line, &column);
    if (length > 0) {
      s->fenced_length = (uint8_t)(length > 255 ? 255 : length);
      s->fenced_column = (uint8_t)(column > 255 ? 255 : column);
      s->mode = CODE;
      return CODE_FENCE_LINE;
    }
  }

  if (is_heading(line)) {
    s->mode = PREAMBLE;
    if (s->in_toc && hashes_of(line) > 1) return TOC_LINE;
    s->seen_heading = true;
    s->in_toc = line->toc;
    return HEADING_LINE;
  }

  if (s->in_toc) {
    s->mode = PREAMBLE;
    return TOC_LINE;
  }

  if (!s->seen_heading) return prose_kind(s, line, PROSE_LINE, PREAMBLE);

  switch (s->mode) {
    case PREAMBLE:
      if (is_arrow(line)) {
        s->awaiting_fence = is_bare_arrow(line);
        s->mode = CODE;
        return ARROW_LINE;
      }
      if (is_tilde(line)) return prose_kind(s, line, TILDE_LINE, PROSE);
      return prose_kind(s, line, PROSE_LINE, PREAMBLE);
    case CODE:
      if (is_tilde(line)) return prose_kind(s, line, TILDE_LINE, PROSE);
      s->awaiting_fence = awaiting && line->last_mark < 0;
      return CODE_LINE;
    default:
      if (is_arrow(line)) {
        s->awaiting_fence = is_bare_arrow(line);
        s->mode = CODE;
        return ARROW_LINE;
      }
      return prose_kind(s, line, PROSE_LINE, PROSE);
  }
}

static bool scan_newline(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead == '\r') lexer->advance(lexer, false);
  if (lexer->lookahead == '\n') lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  s->at_line_start = true;
  lexer->result_symbol = NEWLINE;
  return true;
}

static bool scan(Scanner *s, TSLexer *lexer, const bool *valid) {
  bool recovering = valid[ERROR_SENTINEL];

  if (!s->at_line_start) {
    if (!valid[NEWLINE] && !recovering) return false;
    if (lexer->eof(lexer) || lexer->lookahead == '\n' ||
        lexer->lookahead == '\r')
      return scan_newline(s, lexer);
    return false;
  }

  if (lexer->eof(lexer)) return false;

  lexer->mark_end(lexer);
  Line line;
  peek_line(lexer, &line);
  enum TokenType kind = classify_line(s, &line);
  if (!valid[kind] && !recovering) return false;
  s->at_line_start = false;
  lexer->result_symbol = kind;
  return true;
}

void *tree_sitter_loom_external_scanner_create(void) {
  Scanner *s = ts_calloc(1, sizeof(Scanner));
  s->at_line_start = true;
  return s;
}

void tree_sitter_loom_external_scanner_destroy(void *payload) {
  ts_free(payload);
}

unsigned tree_sitter_loom_external_scanner_serialize(void *payload,
                                                     char *buffer) {
  Scanner *s = payload;
  buffer[0] = (char)s->at_line_start;
  buffer[1] = (char)s->started;
  buffer[2] = (char)s->seen_heading;
  buffer[3] = (char)s->in_frontmatter;
  buffer[4] = (char)s->in_toc;
  buffer[5] = (char)s->quote_length;
  buffer[6] = (char)s->quote_column;
  buffer[7] = (char)s->in_note;
  buffer[8] = (char)s->fenced_length;
  buffer[9] = (char)s->fenced_column;
  buffer[10] = (char)s->awaiting_fence;
  buffer[11] = (char)s->mode;
  return 12;
}

void tree_sitter_loom_external_scanner_deserialize(void *payload,
                                                   const char *buffer,
                                                   unsigned length) {
  Scanner *s = payload;
  memset(s, 0, sizeof(Scanner));
  s->at_line_start = true;
  if (length < 12) return;
  s->at_line_start = buffer[0];
  s->started = buffer[1];
  s->seen_heading = buffer[2];
  s->in_frontmatter = buffer[3];
  s->in_toc = buffer[4];
  s->quote_length = (uint8_t)buffer[5];
  s->quote_column = (uint8_t)buffer[6];
  s->in_note = buffer[7];
  s->fenced_length = (uint8_t)buffer[8];
  s->fenced_column = (uint8_t)buffer[9];
  s->awaiting_fence = buffer[10];
  s->mode = (uint8_t)buffer[11];
}

bool tree_sitter_loom_external_scanner_scan(void *payload, TSLexer *lexer,
                                            const bool *valid_symbols) {
  return scan(payload, lexer, valid_symbols);
}
