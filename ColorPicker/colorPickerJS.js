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
    var rNumber = +document.getElementById("rNumber").value;
    var gNumber = +document.getElementById("gNumber").value;
    var bNumber = +document.getElementById("bNumber").value;


    var rho = 0;
    var gamma = 0;
    var beta = 0;


    if (rNumber, gNumber, bNumber <= 1 && rNumber >=0 && gNumber >=0 && bNumber >= 0) {
        window.alert("You entered: " + rNumber + ", " + gNumber + ", " + bNumber);

    }
    else {
        window.alert("Please enter a value that is between 0.0 - 1.0");
    }

    rho = (1 / (rNumber + gNumber + bNumber) * rNumber);
    gamma = (1 / (rNumber + gNumber + bNumber) * gNumber);
    beta = (1 / (rNumber + gNumber + bNumber) * bNumber);


    window.alert("The rho value is: " + rho.toFixed(1));
    window.alert("The gamma value is: " + gamma.toFixed(1));
    window.alert("The beta value is: " + beta.toFixed(1));

}


