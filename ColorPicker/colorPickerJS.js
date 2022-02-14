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



function f() {
    var rNumber = document.getElementById("rNumber").value;
    var gNumber = document.getElementById("gNumber").value;
    var bNumber = document.getElementById("bNumber").value;

    var rho = 0;
    var gamma = 0;
    var beta = 0;

    //(1/bNumber) * bNumber;

    if (rNumber, gNumber, bNumber <= 1 && rNumber >=0 && gNumber >=0 && bNumber >= 0) {
        window.alert("You entered: " + rNumber + " " + gNumber + " " + bNumber);

        if (rNumber = 0) {
            rho = 0
        }
        if (gNumber = 0) {
            gamma = 0
        }
        if (bNumber = 0) {
            beta = 0
        }
        window.alert("The rho value is: " + ((1/rNumber) * rNumber);
        window.alert("The gamma value is: " + gamma);
        window.alert("The beta value is: " + beta);


    }
    else {
        window.alert("Please enter a value that is between 0.0 - 1.0")
    }


}


