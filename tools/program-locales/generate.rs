use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let inputs = env::var("WAFFLE_PROGRAM_LOCALE_INPUTS")?;
    let version = env::var("CARGO_PKG_VERSION")?;
    let manifest = Path::new(&inputs).join(format!("{version}.inputs"));
    println!("cargo:rerun-if-env-changed=WAFFLE_PROGRAM_LOCALE_INPUTS");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let mut output = String::from("pub fn get_embedded_locale(key: &str) -> Option<&'static str> {\n    match key {\n");
    for entry in fs::read_to_string(&manifest)?.lines() {
        let (key, path) = entry.split_once('\t').ok_or("Invalid locale input")?;
        if !key.ends_with("/en-US.ftl") {
            return Err("Only English catalogs are supported".into());
        }
        println!("cargo:rerun-if-changed={path}");
        output.push_str(&format!("        {key:?} => Some({:?}),\n", fs::read_to_string(path)?));
    }
    output.push_str("        _ => None,\n    }\n}\n");
    let out_dir = env::var("OUT_DIR")?;
    fs::write(Path::new(&out_dir).join("embedded_locales.rs"), output)?;
    fs::write(Path::new(&out_dir).join("waffle-program-locale-inputs"), inputs)?;
    fs::write(Path::new(&out_dir).join("waffle-program-locale-version"), version)?;
    Ok(())
}
