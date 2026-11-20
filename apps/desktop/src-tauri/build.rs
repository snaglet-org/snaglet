fn main() {
    let profile =
        std::env::var("SNAGLET_BUILD_PROFILE").unwrap_or_else(|_| "desktop-production".to_string());
    println!("cargo:rustc-env=SNAGLET_BUILD_PROFILE={profile}");
    tauri_build::build()
}
