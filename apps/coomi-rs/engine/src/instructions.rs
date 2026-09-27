use anyhow::Context;
use anyhow::Result;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

pub fn discover_project_instructions(cwd: &Path) -> Result<String> {
    let cwd = cwd
        .canonicalize()
        .with_context(|| format!("invalid working directory {}", cwd.display()))?;
    let root = find_project_root(&cwd);
    let mut directories = cwd
        .ancestors()
        .take_while(|path| path.starts_with(&root))
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    directories.reverse();

    let mut sections = Vec::new();
    for directory in directories {
        for name in ["AGENTS.md", "COOMI.md"] {
            let path = directory.join(name);
            if path.is_file() {
                let content = fs::read_to_string(&path)
                    .with_context(|| format!("failed to read {}", path.display()))?;
                sections.push(format!("## {}\n{}", path.display(), content.trim()));
            }
        }
    }
    Ok(sections.join("\n\n"))
}

fn find_project_root(cwd: &Path) -> PathBuf {
    cwd.ancestors()
        .find(|path| path.join(".git").exists())
        .unwrap_or(cwd)
        .to_path_buf()
}
