use unicode_width::UnicodeWidthChar;

#[derive(Clone, Debug, Default)]
pub struct Editor {
    content: Vec<char>,
    cursor: usize,
}

impl Editor {
    pub fn text(&self) -> String {
        self.content.iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }

    pub fn clear(&mut self) {
        self.content.clear();
        self.cursor = 0;
    }

    pub fn take(&mut self) -> String {
        let text = self.text();
        self.clear();
        text
    }

    pub fn set(&mut self, text: impl AsRef<str>) {
        self.content = text.as_ref().chars().collect();
        self.cursor = self.content.len();
    }

    pub fn insert(&mut self, character: char) {
        self.content.insert(self.cursor, character);
        self.cursor += 1;
    }

    pub fn insert_str(&mut self, text: &str) {
        for character in text.chars() {
            self.insert(character);
        }
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.content.remove(self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.content.len() {
            self.content.remove(self.cursor);
        }
    }

    pub fn move_left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.content.len());
    }

    pub fn move_home(&mut self) {
        self.cursor = self.content[..self.cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |position| position + 1);
    }

    pub fn move_end(&mut self) {
        self.cursor = self.content[self.cursor..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(self.content.len(), |position| self.cursor + position);
    }

    pub fn line_count(&self, width: u16) -> u16 {
        let (_, row) = position_for(&self.content, self.content.len(), width.max(1));
        row.saturating_add(1)
    }

    pub fn cursor_position(&self, width: u16) -> (u16, u16) {
        position_for(&self.content, self.cursor, width.max(1))
    }
}

fn position_for(content: &[char], end: usize, width: u16) -> (u16, u16) {
    let mut column = 0_u16;
    let mut row = 0_u16;
    for character in content.iter().take(end) {
        if *character == '\n' {
            column = 0;
            row = row.saturating_add(1);
            continue;
        }
        let character_width = u16::try_from(character.width().unwrap_or(0)).unwrap_or(1);
        if column.saturating_add(character_width) > width {
            column = 0;
            row = row.saturating_add(1);
        }
        column = column.saturating_add(character_width);
        if column >= width {
            column = 0;
            row = row.saturating_add(1);
        }
    }
    (column, row)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_unicode_by_character() {
        let mut editor = Editor::default();
        editor.insert_str("你a");
        editor.move_left();
        editor.backspace();
        assert_eq!(editor.text(), "a");
    }

    #[test]
    fn tracks_wrapped_cursor_cells() {
        let mut editor = Editor::default();
        editor.insert_str("abcd你");
        assert_eq!(editor.cursor_position(5), (2, 1));
        assert_eq!(editor.line_count(5), 2);
    }
}
