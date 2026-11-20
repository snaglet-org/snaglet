//! Handle-based private ACL support for desktop-owned secret files.

use std::fs::{File, OpenOptions};
use std::path::Path;

#[cfg(target_os = "windows")]
pub fn private_secret_access(write: bool) -> u32 {
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Storage::FileSystem::{READ_CONTROL, WRITE_DAC};

    // Generic file read/write does not include WRITE_DAC. SetSecurityInfo
    // needs that right on this exact handle; inspection needs READ_CONTROL.
    GENERIC_READ | READ_CONTROL | WRITE_DAC | if write { GENERIC_WRITE } else { 0 }
}

#[cfg(target_os = "windows")]
fn validate_secret_file_handle(file: &File, path: &Path) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetFileType, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_TYPE_DISK,
    };

    let handle = file.as_raw_handle() as *mut std::ffi::c_void;
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return Err(format!("refusing non-disk private file {}", path.display()));
    }
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(format!(
            "cannot inspect private file {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    if information.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
    {
        return Err(format!(
            "refusing reparse-point or directory private file {}",
            path.display()
        ));
    }
    if information.nNumberOfLinks != 1 {
        return Err(format!(
            "refusing multiply linked private file {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn protect_secret_file_handle(file: &File, path: &Path) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetSecurityInfo, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION,
    };

    validate_secret_file_handle(file, path)?;
    let mut descriptor = std::ptr::null_mut();
    let sddl: Vec<u16> = "D:P(A;;FA;;;OW)\0".encode_utf16().collect();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(format!(
            "cannot create private Windows ACL for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let mut dacl_present = 0;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut dacl_defaulted = 0;
    let extracted = unsafe {
        GetSecurityDescriptorDacl(
            descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    };
    if extracted == 0 || dacl_present == 0 || dacl.is_null() {
        unsafe { LocalFree(descriptor) };
        return Err(format!(
            "cannot read private Windows ACL for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    // SetSecurityInfo is Microsoft's documented filesystem-object API. The
    // handle identifies the exact file, so a path swap cannot redirect the ACL.
    let applied = unsafe {
        SetSecurityInfo(
            file.as_raw_handle() as *mut std::ffi::c_void,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        )
    };
    unsafe { LocalFree(descriptor) };
    if applied != 0 {
        return Err(format!(
            "cannot protect {} with a private Windows ACL: Windows error {applied}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn protect_secret_file_handle(_file: &File, _path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn open_existing_private_secret_file(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    // Open a reparse point itself instead of following it. The handle check
    // below rejects it, closing the metadata-to-open replacement race.
    let file = OpenOptions::new()
        .access_mode(private_secret_access(false))
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("cannot open private file {}: {error}", path.display()))?;
    validate_secret_file_handle(&file, path)?;
    Ok(file)
}

#[cfg(test)]
#[cfg(target_os = "windows")]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorControl, DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    };

    #[test]
    fn private_secret_file_has_a_protected_dacl() {
        let dir = std::env::temp_dir().join(format!(
            "snaglet-secret-acl-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock after Unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create disposable secret test directory");
        let ordinary_path = dir.join("ordinary-handle.key");
        let ordinary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&ordinary_path)
            .expect("create ordinary write handle");
        assert!(protect_secret_file_handle(&ordinary, &ordinary_path)
            .expect_err("DACL mutation requires explicit WRITE_DAC")
            .contains("Windows error 5"));
        drop(ordinary);
        let path = dir.join("credential.key");
        let mut file = OpenOptions::new()
            .write(true)
            .access_mode(private_secret_access(true))
            .create_new(true)
            .open(&path)
            .expect("create empty secret");
        protect_secret_file_handle(&file, &path).expect("protect empty secret before write");
        file.write_all(b"secret").expect("write after private ACL");

        let mut descriptor = std::ptr::null_mut();
        let security = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as *mut std::ffi::c_void,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(security, 0, "read secret DACL: Windows error {security}");
        let mut control = 0u16;
        let mut revision = 0u32;
        assert_ne!(
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
            0
        );
        assert_ne!(
            control & SE_DACL_PROTECTED,
            0,
            "secret DACL must not inherit grants"
        );
        unsafe { LocalFree(descriptor) };
        drop(file);
        let mut reopened =
            open_existing_private_secret_file(&path).expect("reopen protected secret");
        protect_secret_file_handle(&reopened, &path).expect("reapply private ACL before read");
        let mut contents = String::new();
        reopened
            .read_to_string(&mut contents)
            .expect("read protected secret");
        assert_eq!(contents, "secret");
        drop(reopened);
        let alias = dir.join("hard-link.key");
        std::fs::hard_link(&path, &alias).expect("create disposable hard-link fixture");
        assert!(open_existing_private_secret_file(&path)
            .expect_err("reject multiply linked secret before ACL/read")
            .contains("multiply linked"));
        assert!(open_existing_private_secret_file(&dir).is_err());
        std::fs::remove_dir_all(&dir).expect("remove disposable secret test directory");
    }
}
