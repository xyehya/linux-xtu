//! The app's [`Confirmer`]: a GTK message dialog, modal to the main window (D-053 item 4). It is a native window, outside the webview:
//! page scripts cannot see or click it. Cancel is focused and is the default response, so Enter or Escape never writes. The write button
//! names the count ("Apply 3 writes"), carries GTK's `destructive-action` style and starts insensitive: it becomes clickable `ARM_DELAY`
//! (700 ms, [`Arming`], polled every 50 ms) after the dialog is mapped, and goes insensitive again when a focus the dialog held is lost —
//! a click or Enter meant for the page a moment earlier cannot land on it. The dialog is presented (focused) when it is shown (QA-26). `gtk` 0.18 is the crate tauri itself uses
//! on Linux (already in Cargo.lock); no dialog plugin is added.

use std::sync::mpsc;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::confirm::{Answer, Arming, ConfirmRequest, Confirmer};

pub struct NativeConfirmer {
    app: AppHandle,
}

impl NativeConfirmer {
    pub fn new(app: AppHandle) -> NativeConfirmer {
        NativeConfirmer { app }
    }
}

impl Confirmer for NativeConfirmer {
    fn confirm(&self, req: &ConfirmRequest) -> Answer {
        let (tx, rx) = mpsc::channel::<bool>();
        let (title, primary, secondary, ok_label) = (req.title(), req.primary(), req.secondary(), req.ok_label());
        let app = self.app.clone();
        let shown = self.app.run_on_main_thread(move || show(&app, &title, &primary, &secondary, &ok_label, tx));
        if let Err(e) = shown {
            return Answer::Unavailable(format!("the window is not available: {e}"));
        }
        // Blocks this worker thread (helper_call runs on spawn_blocking) until the operator answers.
        match rx.recv() {
            Ok(true) => Answer::Yes,
            Ok(false) => Answer::No,
            Err(_) => Answer::Unavailable("the dialog closed without an answer".to_string()),
        }
    }
}

#[cfg(target_os = "linux")]
fn show(app: &AppHandle, title: &str, primary: &str, secondary: &str, ok_label: &str, tx: mpsc::Sender<bool>) {
    use gtk::prelude::*;
    let parent = app.get_webview_window("main").and_then(|w| w.gtk_window().ok());
    let dialog = gtk::MessageDialog::new(
        parent.as_ref(),
        gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
        gtk::MessageType::Warning,
        gtk::ButtonsType::None,
        primary,
    );
    dialog.set_title(title);
    dialog.set_secondary_text(Some(secondary));
    dialog.add_button("Cancel", gtk::ResponseType::Cancel);
    let write = dialog.add_button(ok_label, gtk::ResponseType::Accept);
    write.style_context().add_class("destructive-action");
    dialog.set_default_response(gtk::ResponseType::Cancel);
    write.set_sensitive(false);
    let answered = std::rc::Rc::new(std::cell::Cell::new(false));
    let tx = Mutex::new(Some(tx));
    let done = answered.clone();
    dialog.connect_response(move |d, response| {
        // an insensitive button cannot be activated; the check is belt and braces (Accept counts only once armed)
        let yes = response == gtk::ResponseType::Accept && d.widget_for_response(gtk::ResponseType::Accept).is_some_and(|w| w.is_sensitive());
        if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = tx.send(yes);
        }
        done.set(true);
        // SAFETY: the dialog is owned by this handler alone; nothing uses it after its response.
        unsafe { d.destroy() };
    });
    dialog.show_all();
    // QA-26: ask the window system to give the dialog the focus now. A modal dialog that is only shown can sit unfocused until the first click lands on it, and that
    // click then finds the write button still insensitive. The arming clock does not wait for the focus either (it starts when the dialog is mapped, `Arming`).
    dialog.present();
    if let Some(cancel) = dialog.widget_for_response(gtk::ResponseType::Cancel) {
        cancel.grab_focus();
    }
    let mut arming = Arming::default();
    let watched = dialog.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(50), move || {
        if answered.get() {
            return gtk::glib::ControlFlow::Break;
        }
        let armed = arming.tick(std::time::Instant::now(), watched.is_active());
        if write.is_sensitive() != armed {
            write.set_sensitive(armed);
        }
        gtk::glib::ControlFlow::Continue
    });
}

/// No native dialog on other platforms: nothing is approved (the app is built for Linux only).
#[cfg(not(target_os = "linux"))]
fn show(_app: &AppHandle, _title: &str, _primary: &str, _secondary: &str, _ok_label: &str, tx: mpsc::Sender<bool>) {
    drop(tx);
}
