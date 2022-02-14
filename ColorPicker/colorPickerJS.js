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

function draw() {
    var canvas = document.getElementById('color_canvas');
    if (canvas.getContext) {
        var ctx = canvas.getContext('2d');

        ctx.beginPath();
        ctx.moveTo(275, 150);
        ctx.lineTo(100, 150);
        ctx.lineTo(180, 5);
        ctx.fillStyle = "dimgrey";
        ctx.fill();
    }
}
draw();