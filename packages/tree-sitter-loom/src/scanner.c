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
  VERBATIM_LINE,
  BOX_LINE,
  BOX_BODY_LINE,
  BOX_CLOSE_LINE,
  DIVIDER_LINE,
  BOX_NAME,
  NEWLINE,
  ERROR_SENTINEL,
};

enum Mode { PREAMBLE, CODE, PROSE };

typedef struct {
  bool at_line_start;
  bool started;
  bool seen_heading;
  bool in_frontmatter;
  uint8_t quote_length;
  uint8_t quote_column;
  bool in_box;
  bool discussion;
  uint8_t fenced_length;
  uint8_t fenced_column;
  bool awaiting_fence;
  uint8_t mode;
  uint32_t name_reach;
} Scanner;

#define HEAD_SIZE 48

typedef struct {
  char head[HEAD_SIZE];
  uint32_t head_length;
  uint32_t length;
  int32_t last_mark;
  int32_t brace_open;
  int32_t mark_before_open;
  int32_t braces_close;
  int32_t mark_before_braces;
} Line;

static bool is_space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\v' || c == '\f' || c == '\r';
}

static void peek_line(TSLexer *lexer, Line *line) {
  memset(line, 0, sizeof(Line));
  line->last_mark = -1;
  line->brace_open = -1;
  line->braces_close = -1;
  while (!lexer->eof(lexer) && lexer->lookahead != '\n' &&
         lexer->lookahead != '\r') {
    int32_t c = lexer->lookahead;
    int32_t at = (int32_t)line->length;
    if (line->head_length < HEAD_SIZE)
      line->head[line->head_length++] = c < 128 ? (char)c : '\x01';
    if (c == '{') {
      line->brace_open = at;
      line->mark_before_open = line->last_mark;
    }
    if (c == '}') {
      line->braces_close = line->brace_open < 0 ? -1 : at;
      line->mark_before_braces = line->mark_before_open;
      line->brace_open = -1;
    }
    if (!is_space(c)) line->last_mark = at;
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

static bool is_divider(const Line *line) {
  uint32_t dashes = 0;
  while (dashes < line->head_length && line->head[dashes] == '-') dashes++;
  return dashes >= 3 && line->last_mark == (int32_t)dashes - 1;
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

static uint32_t box_fence_of(const Line *line, uint32_t *column) {
  uint32_t at = 0;
  while (at < line->head_length &&
         (line->head[at] == ' ' || line->head[at] == '\t'))
    at++;
  uint32_t end = at;
  while (end < line->head_length && line->head[end] == ':') end++;
  *column = at;
  return end - at >= 3 ? end - at : 0;
}

static bool closes_box(const Line *line) {
  uint32_t column;
  return box_fence_of(line, &column) == 3 &&
         line->last_mark == (int32_t)column + 2;
}

static int32_t name_end_of(const Line *line) {
  bool braced =
      line->braces_close >= 0 && line->braces_close == line->last_mark;
  return braced ? line->mark_before_braces : line->last_mark;
}

static uint32_t name_reach_of(const Line *line, uint32_t column) {
  int32_t after = (int32_t)column + 3;
  int32_t end = name_end_of(line);
  return end < after ? 0 : (uint32_t)(end - after + 1);
}

static uint32_t skip_spaces(const Line *line, uint32_t at) {
  while (at < line->head_length && is_space(line->head[at])) at++;
  return at;
}

static uint32_t after_part(const Line *line, uint32_t at) {
  if (!head_has(line, at, "Part") || at + 4 >= line->head_length ||
      !is_space(line->head[at + 4]))
    return at;
  uint32_t name = skip_spaces(line, at + 4);
  uint32_t end = name;
  while (end < line->head_length && line->head[end] != ',' &&
         line->head[end] != ':')
    end++;
  if (end == name || end >= line->head_length || line->head[end] != ',')
    return at;
  return skip_spaces(line, end + 1);
}

static bool names_discussion(const Line *line) {
  uint32_t at = after_part(line, indent_of(line));
  if (!head_has(line, at, "Discussion")) return false;
  uint32_t end = at + 10;
  if (end < line->head_length && line->head[end] == ':') return true;
  if (end >= line->head_length || !is_space(line->head[end])) return false;
  while (end < line->head_length && line->head[end] != ':') end++;
  return end < line->head_length;
}

static enum TokenType prose_kind(Scanner *s, const Line *line,
                                 enum TokenType kind, enum Mode mode) {
  uint32_t column;
  uint32_t length = fence_of(line, &column);
  s->mode = mode;
  s->quote_length = (uint8_t)(length > 255 ? 255 : length);
  s->quote_column = (uint8_t)(column > 255 ? 255 : column);
  if (length > 0) return VERBATIM_LINE;
  uint32_t colons = box_fence_of(line, &column);
  if (colons == 0) return kind;
  if (colons > 3) return VERBATIM_LINE;
  s->in_box = true;
  s->name_reach = name_reach_of(line, column);
  return BOX_LINE;
}

static enum TokenType classify_line(Scanner *s, const Line *line) {
  bool first = !s->started;
  s->started = true;
  s->name_reach = 0;

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
    if (names_discussion(line)) s->discussion = true;
    return FIELD_LINE;
  }

  if (s->quote_length > 0) {
    if (closes_fence(line, s->quote_length, s->quote_column)) s->quote_length = 0;
    s->mode = s->seen_heading ? PROSE : PREAMBLE;
    return VERBATIM_LINE;
  }

  if (s->in_box) {
    s->mode = s->seen_heading ? PROSE : PREAMBLE;
    if (!closes_box(line)) return BOX_BODY_LINE;
    s->in_box = false;
    return BOX_CLOSE_LINE;
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
    s->seen_heading = true;
    return HEADING_LINE;
  }

  if (!s->seen_heading) return prose_kind(s, line, PROSE_LINE, PREAMBLE);

  if (is_divider(line)) {
    s->mode = PREAMBLE;
    return DIVIDER_LINE;
  }

  if (s->discussion) {
    if (is_tilde(line)) return prose_kind(s, line, TILDE_LINE, PROSE);
    return prose_kind(s, line, PROSE_LINE, s->mode == PREAMBLE ? PREAMBLE : PROSE);
  }

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

static bool scan_box_name(Scanner *s, TSLexer *lexer) {
  uint32_t reach = s->name_reach;
  s->name_reach = 0;
  while (reach > 0 && is_space(lexer->lookahead)) {
    lexer->advance(lexer, true);
    reach--;
  }
  while (reach > 0) {
    lexer->advance(lexer, false);
    reach--;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = BOX_NAME;
  return true;
}

static bool scan(Scanner *s, TSLexer *lexer, const bool *valid) {
  bool recovering = valid[ERROR_SENTINEL];

  if (!s->at_line_start) {
    if (valid[BOX_NAME] && !recovering && s->name_reach > 0)
      return scan_box_name(s, lexer);
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
  buffer[4] = (char)s->quote_length;
  buffer[5] = (char)s->quote_column;
  buffer[6] = (char)s->in_box;
  buffer[7] = (char)s->fenced_length;
  buffer[8] = (char)s->fenced_column;
  buffer[9] = (char)s->awaiting_fence;
  buffer[10] = (char)s->mode;
  buffer[11] = (char)s->discussion;
  memcpy(buffer + 12, &s->name_reach, sizeof(s->name_reach));
  return 16;
}

void tree_sitter_loom_external_scanner_deserialize(void *payload,
                                                   const char *buffer,
                                                   unsigned length) {
  Scanner *s = payload;
  memset(s, 0, sizeof(Scanner));
  s->at_line_start = true;
  if (length < 16) return;
  s->at_line_start = buffer[0];
  s->started = buffer[1];
  s->seen_heading = buffer[2];
  s->in_frontmatter = buffer[3];
  s->quote_length = (uint8_t)buffer[4];
  s->quote_column = (uint8_t)buffer[5];
  s->in_box = buffer[6];
  s->fenced_length = (uint8_t)buffer[7];
  s->fenced_column = (uint8_t)buffer[8];
  s->awaiting_fence = buffer[9];
  s->mode = (uint8_t)buffer[10];
  s->discussion = buffer[11];
  memcpy(&s->name_reach, buffer + 12, sizeof(s->name_reach));
}

bool tree_sitter_loom_external_scanner_scan(void *payload, TSLexer *lexer,
                                            const bool *valid_symbols) {
  return scan(payload, lexer, valid_symbols);
}
