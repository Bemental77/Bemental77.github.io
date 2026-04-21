
function validateFormOnSubmit(theForm) {
    var reason = "";
    reason += validateName(theForm.name);
    reason += validatePhone(theForm.email);
    reason += validateEmail(theForm.message);

    if (reason != "") {
        alert("Some fields need correction:\n" + reason);
    } else {
        window.open('mailto:caseybement@caseybement.com?subject=subject&body=body');
    }
    return false;
}