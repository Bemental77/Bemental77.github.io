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

    //The following code produces a NaN if 0 is entered, though cannot find out why.
    //The math asked to be used to convert to barycentric always results in a 1 if a value over 0 is entered.
    //When asking the instructor about this, he confirmed that this is the correct math to use.
    //This must be incorrect however, because this is useless.
    if (rNumber, gNumber, bNumber <= 1 && rNumber >=0 && gNumber >=0 && bNumber >= 0) {
        window.alert("You entered: " + rNumber + ", " + gNumber + ", " + bNumber);





    }
    else {
        window.alert("Please enter a value that is between 0.0 - 1.0");
    }

    window.alert("The rho value is: " + ((1 / rNumber) * rNumber));
    window.alert("The gamma value is: " + ((1 / gNumber) * gNumber));
    window.alert("The beta value is: " + ((1 / bNumber) * bNumber));

}


