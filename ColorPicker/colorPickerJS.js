function f() {
    var rNumber = document.getElementById("rNumber").value;
    var gNumber = document.getElementById("gNumber").value;
    var bNumber = document.getElementById("bNumber").value;

    if (rNumber, gNumber, bNumber < 256 && rNumber >=1 && gNumber >=1 && bNumber >= 1) {
        window.alert(rNumber + " " + gNumber + " " + bNumber);
    }
    else {
        window.alert("Please enter a value that is between 1-255")
    }



}

