use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;

pub const CANVAS: Color = Color::Rgb(13, 15, 19);
pub const SURFACE: Color = Color::Rgb(22, 25, 31);
pub const BORDER: Color = Color::Rgb(58, 64, 76);
pub const TEXT: Color = Color::Rgb(226, 229, 235);
pub const MUTED: Color = Color::Rgb(139, 145, 158);
pub const BLUE: Color = Color::Rgb(45, 97, 198);
pub const ORANGE: Color = Color::Rgb(212, 116, 88);
pub const MINT: Color = BLUE;
pub const CORAL: Color = ORANGE;
pub const AMBER: Color = Color::Rgb(226, 176, 85);
pub const SKY: Color = Color::Rgb(116, 159, 222);
pub const ERROR: Color = Color::Rgb(245, 112, 112);
pub const SUCCESS: Color = Color::Rgb(131, 209, 146);

pub fn base() -> Style {
    Style::default().fg(TEXT).bg(CANVAS)
}

pub fn title() -> Style {
    Style::default().fg(BLUE).add_modifier(Modifier::BOLD)
}

pub fn selected() -> Style {
    Style::default()
        .fg(CANVAS)
        .bg(BLUE)
        .add_modifier(Modifier::BOLD)
}

pub fn key() -> Style {
    Style::default().fg(AMBER).add_modifier(Modifier::BOLD)
}
