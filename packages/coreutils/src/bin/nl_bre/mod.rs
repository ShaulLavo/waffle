use std::ffi::OsString;
use std::iter::Peekable;
use std::str::Chars;

pub fn arguments(matches: &clap::ArgMatches) -> Result<Vec<OsString>, String> {
    let mut args = vec![OsString::from("nl")];
    for option in ["body-numbering", "header-numbering", "footer-numbering"] {
        append_style(&mut args, matches, option)?;
    }
    for option in ["section-delimiter", "number-separator", "number-format"] {
        append_raw(&mut args, matches, option);
    }
    append_number::<i64>(&mut args, matches, "starting-line-number");
    append_number::<i64>(&mut args, matches, "line-increment");
    append_number::<u64>(&mut args, matches, "join-blank-lines");
    append_number::<u64>(&mut args, matches, "number-width");
    if !matches.get_flag("no-renumber") {
        args.push(OsString::from("--no-renumber"));
    }
    args.push(OsString::from("--"));
    if let Some(files) = matches.get_many::<OsString>("file") {
        args.extend(files.cloned());
    }
    Ok(args)
}

fn append_raw(args: &mut Vec<OsString>, matches: &clap::ArgMatches, option: &str) {
    let Some(values) = matches.get_raw(option) else {
        return;
    };
    for value in values {
        args.push(OsString::from(format!("--{option}")));
        args.push(value.to_owned());
    }
}

fn append_number<T>(args: &mut Vec<OsString>, matches: &clap::ArgMatches, option: &str)
where
    T: ToString + Clone + Send + Sync + 'static,
{
    let Some(value) = matches.get_one::<T>(option) else {
        return;
    };
    args.push(OsString::from(format!("--{option}={}", value.to_string())));
}

fn append_style(
    args: &mut Vec<OsString>,
    matches: &clap::ArgMatches,
    option: &str,
) -> Result<(), String> {
    let Some(value) = matches.get_one::<String>(option) else {
        return Ok(());
    };
    let style = match value.strip_prefix('p') {
        Some(pattern) => format!("p(?-u:{})", basic_pattern(pattern)?),
        None => value.to_owned(),
    };
    args.push(OsString::from(format!("--{option}={style}")));
    Ok(())
}

#[derive(Clone, Copy)]
enum Bracket {
    Outside,
    First,
    Body,
}

struct Pattern<'a> {
    chars: Peekable<Chars<'a>>,
    bracket: Bracket,
    branch_start: bool,
    result: String,
}

fn basic_pattern(pattern: &str) -> Result<String, String> {
    let mut state = Pattern {
        chars: pattern.chars().peekable(),
        bracket: Bracket::Outside,
        branch_start: true,
        result: String::with_capacity(pattern.len()),
    };
    while let Some(ch) = state.chars.next() {
        state.character(ch)?;
    }
    Ok(state.result)
}

impl Pattern<'_> {
    fn character(&mut self, ch: char) -> Result<(), String> {
        if !matches!(self.bracket, Bracket::Outside) {
            self.bracket_character(ch)?;
            return Ok(());
        }
        match ch {
            '[' => self.open_bracket(),
            '\\' => self.escape()?,
            '^' => self.anchor(ch, self.branch_start),
            '$' => self.anchor(ch, self.branch_end()),
            '*' if self.branch_start => self.result.push_str(r"\*"),
            '(' | ')' | '+' | '?' | '|' | '{' | '}' => self.literal(ch),
            _ => self.result.push(ch),
        }
        if ch != '\\' {
            self.branch_start = false;
        }
        Ok(())
    }

    fn bracket_character(&mut self, ch: char) -> Result<(), String> {
        if ch == '[' && self.chars.peek() == Some(&':') {
            self.named_class()?;
            self.bracket = Bracket::Body;
            return Ok(());
        }
        if ch == ']' && matches!(self.bracket, Bracket::Body) {
            self.bracket = Bracket::Outside;
        }
        match ch {
            '[' | '\\' | '&' | '~' => self.literal(ch),
            _ => self.result.push(ch),
        }
        if !matches!(self.bracket, Bracket::Outside) {
            self.bracket = Bracket::Body;
        }
        Ok(())
    }

    fn named_class(&mut self) -> Result<(), String> {
        self.chars.next();
        let name: String = self.chars.by_ref().take_while(|ch| *ch != ':').collect();
        if self.chars.next() != Some(']')
            || !matches!(
                name.as_str(),
                "alnum"
                    | "alpha"
                    | "blank"
                    | "cntrl"
                    | "digit"
                    | "graph"
                    | "lower"
                    | "print"
                    | "punct"
                    | "space"
                    | "upper"
                    | "xdigit"
            )
        {
            return Err("invalid character class name".to_owned());
        }
        self.result.push_str("[:");
        self.result.push_str(&name);
        self.result.push_str(":]");
        Ok(())
    }

    fn open_bracket(&mut self) {
        self.bracket = Bracket::First;
        self.result.push('[');
        if self.chars.peek() == Some(&'^') {
            self.chars.next();
            self.result.push('^');
        }
        if self.chars.peek() == Some(&']') {
            self.chars.next();
            self.result.push_str(r"\]");
            self.bracket = Bracket::Body;
        }
    }

    fn escape(&mut self) -> Result<(), String> {
        let ch = self
            .chars
            .next()
            .ok_or("invalid regular expression: trailing backslash")?;
        if matches!(ch, '1'..='9') {
            return Err("regular expression backreferences are not supported".to_owned());
        }
        self.branch_start = matches!(ch, '(' | '|');
        if matches!(ch, '(' | ')' | '+' | '?' | '|' | '{' | '}') {
            self.result.push(ch);
            return Ok(());
        }
        self.result.push('\\');
        self.result.push(ch);
        Ok(())
    }

    fn literal(&mut self, ch: char) {
        self.result.push('\\');
        self.result.push(ch);
    }

    fn anchor(&mut self, ch: char, active: bool) {
        if !active {
            self.result.push('\\');
        }
        self.result.push(ch);
    }

    fn branch_end(&self) -> bool {
        let mut tail = self.chars.clone();
        match tail.next() {
            None => true,
            Some('\\') => matches!(tail.next(), Some(')' | '|')),
            _ => false,
        }
    }
}
