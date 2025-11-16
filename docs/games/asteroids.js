// == VIBE CODE: ASTEROIDS ==
// By Zyqral

// --- 1. SETUP THE UNIVERSE (CANVAS) ---
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// --- 2. DEFINE GAME CONCEPTS (CLASSES) ---

// ** THE PLAYER (AGENCY) **
class Ship {
    constructor() {
        this.x = canvas.width / 2;
        this.y = canvas.height / 2;
        this.radius = 15;
        this.angle = -Math.PI / 2; // Face up
        this.vel = { x: 0, y: 0 };
        this.rotationSpeed = 0.05;
        this.isTurningLeft = false;
        this.isTurningRight = false;
        this.thrustPower = 0.1;
        this.isThrusting = false;
        this.friction = 0.99;
        this.isDead = false;
    }

    draw() {
        if (this.isDead) return;
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);
        
        ctx.beginPath();
        ctx.moveTo(this.radius, 0); // Nose
        ctx.lineTo(-this.radius * 0.7, -this.radius * 0.8); // Left tail
        ctx.lineTo(-this.radius * 0.7, this.radius * 0.8); // Right tail
        ctx.closePath();
        
        if (this.isThrusting) {
            ctx.fillStyle = "orange";
            ctx.beginPath();
            ctx.moveTo(-this.radius * 0.7, 0);
            ctx.lineTo(-this.radius * 1.5, 0);
            ctx.stroke();
        }
        ctx.stroke();
        ctx.restore();
    }

    update() {
        if (this.isDead) return;
        if (this.isTurningLeft) this.angle -= this.rotationSpeed;
        if (this.isTurningRight) this.angle += this.rotationSpeed;
        if (this.isThrusting) {
            this.vel.x += Math.cos(this.angle) * this.thrustPower;
            this.vel.y += Math.sin(this.angle) * this.thrustPower;
        }
        this.vel.x *= this.friction;
        this.vel.y *= this.friction;
        this.x += this.vel.x;
        this.y += this.vel.y;
        this.wrapScreen();
    }
    
    wrapScreen() {
        if (this.x < 0) this.x = canvas.width;
        if (this.x > canvas.width) this.x = 0;
        if (this.y < 0) this.y = canvas.height;
        if (this.y > canvas.height) this.y = 0;
    }
}

// ** THE BULLET (INTENT) **
class Bullet {
    constructor(x, y, angle) {
        this.x = x;
        this.y = y;
        this.radius = 3;
        this.speed = 10;
        this.vel = {
            x: Math.cos(angle) * this.speed,
            y: Math.sin(angle) * this.speed
        };
        this.life = 60; // 1 second
    }

    draw() {
        ctx.fillStyle = 'yellow';
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
    }

    update() {
        this.x += this.vel.x;
        this.y += this.vel.y;
        this.life--;
    }
}

// ** THE ASTEROID (CHALLENGE) **
class Asteroid {
    constructor(x, y, radius) {
        this.x = x || Math.random() * canvas.width;
        this.y = y || Math.random() * canvas.height;
        this.radius = radius || 50;
        this.vel = {
            x: (Math.random() * 2 - 1) * 1.5,
            y: (Math.random() * 2 - 1) * 1.5
        };
        this.shapeVertices = 10 + Math.floor(Math.random() * 5);
        this.offsets = [];
        for (let i = 0; i < this.shapeVertices; i++) {
            this.offsets.push(Math.random() * (this.radius * 0.4) + (this.radius * 0.6));
        }
    }

    draw() {
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < this.shapeVertices; i++) {
            let angle = (i / this.shapeVertices) * Math.PI * 2;
            let r = this.offsets[i];
            let x = this.x + Math.cos(angle) * r;
            let y = this.y + Math.sin(angle) * r;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
    }

    update() {
        this.x += this.vel.x;
        this.y += this.vel.y;
        this.wrapScreen();
    }
    
    wrapScreen() {
        if (this.x < -this.radius) this.x = canvas.width +
